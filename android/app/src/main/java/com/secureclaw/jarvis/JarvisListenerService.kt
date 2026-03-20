package com.secureclaw.jarvis

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import ai.picovoice.porcupine.Porcupine
import ai.picovoice.porcupine.PorcupineException
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/**
 * ForegroundService de JARVIS — escucha wake word, graba comando, lo procesa
 * con Gemini (function calling) y ejecuta acciones en el teléfono vía AndroidGarra.
 *
 * Flujo completo:
 *  1. Porcupine escucha continuamente → detecta "JARVIS"
 *  2. Graba 5 segundos de comando de voz (misma AudioRecord)
 *  3. Convierte audio a WAV → base64 → Gemini API con tool definitions
 *  4. Gemini devuelve tool calls → AndroidGarra los ejecuta
 *  5. Gemini genera respuesta final → TextToSpeech la habla
 *  6. Vuelve a escuchar wake word
 */
class JarvisListenerService : Service() {

    companion object {
        private const val TAG             = "JARVIS-Listener"
        private const val NOTIF_ID        = 9001
        private const val COMMAND_SECONDS = 5
        // El audio va al Brain (Cloud Function) — el API key queda server-side
        private const val VOICE_WEBHOOK   = "https://us-central1-claw-brain-e6596.cloudfunctions.net/voiceWebhook"
    }

    private var porcupine: Porcupine?     = null
    private var audioRecord: AudioRecord? = null
    private var isListening               = false
    private var sampleRate                = 0
    private var frameLength               = 0

    // Buffer de grabación de comando
    private val commandBuffer       = mutableListOf<Short>()
    private var commandRemaining    = 0     // frames aún por capturar

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private lateinit var garra: AndroidGarra
    private var tts: TextToSpeech? = null

    // Memoria conversacional entre comandos (sin audio, solo texto/tools)
    private var conversationHistory = ""

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "JarvisListenerService iniciado")
        garra = AndroidGarra(applicationContext)

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale("es", "AR")
                Log.d(TAG, "TTS listo")
            }
        }

        startForeground(NOTIF_ID, buildNotification("Escuchando... di \"JARVIS\""))
        startWakeWordDetection()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        isListening = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        porcupine?.delete()
        porcupine = null
        tts?.stop()
        tts?.shutdown()
        serviceScope.cancel()
        Log.d(TAG, "JarvisListenerService detenido")
    }

    // ── Wake word detection ──────────────────────────────────────────────────

    private fun startWakeWordDetection() {
        try {
            porcupine = Porcupine.Builder()
                .setAccessKey(BuildConfig.PORCUPINE_ACCESS_KEY)
                .setKeyword(Porcupine.BuiltInKeyword.JARVIS)
                .setSensitivity(0.7f)
                .build(applicationContext)

            sampleRate  = porcupine!!.sampleRate
            frameLength = porcupine!!.frameLength

            val minBuf = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2
            )

            isListening = true
            audioRecord!!.startRecording()
            Log.d(TAG, "Porcupine OK — sampleRate=$sampleRate frameLength=$frameLength")

            serviceScope.launch { audioLoop() }

        } catch (e: PorcupineException) {
            Log.e(TAG, "Error inicializando Porcupine: ${e.message}")
            updateNotification("⚠️ Error wake word: ${e.message}")
        }
    }

    private suspend fun audioLoop() {
        val frame = ShortArray(frameLength)
        while (isListening) {
            val read = audioRecord?.read(frame, 0, frameLength) ?: break
            if (read != frameLength) continue

            if (commandRemaining > 0) {
                // ── Modo grabación de comando ──────────────────────────────
                commandBuffer.addAll(frame.toList())
                commandRemaining -= frameLength
                if (commandRemaining <= 0) {
                    val samples = commandBuffer.toShortArray()
                    commandBuffer.clear()
                    // Procesar en coroutine separada, no bloquea el loop
                    serviceScope.launch { processCommand(samples) }
                }
            } else {
                // ── Modo detección wake word ───────────────────────────────
                val result = porcupine?.process(frame) ?: break
                if (result >= 0) {
                    Log.d(TAG, "🎤 Wake word detectado")
                    onWakeWordDetected()
                }
            }
        }
    }

    private fun onWakeWordDetected() {
        updateNotification("🎤 Escuchando comando...")
        speak("Sí")
        commandBuffer.clear()
        commandRemaining = sampleRate * COMMAND_SECONDS
    }

    // ── Procesamiento de comando ─────────────────────────────────────────────

    private suspend fun processCommand(samples: ShortArray) {
        updateNotification("🧠 Procesando...")
        Log.d(TAG, "Procesando comando: ${samples.size} samples")

        val wavBytes    = shortArrayToWav(samples)
        val base64Audio = Base64.encodeToString(wavBytes, Base64.NO_WRAP)

        val response = callVoiceWebhook(base64Audio)
        Log.d(TAG, "Respuesta JARVIS: $response")

        if (response.isNotBlank()) {
            withContext(Dispatchers.Main) { speak(response) }
        }

        updateNotification("Escuchando... di \"JARVIS\"")
    }

    // ── voiceWebhook: envía audio al Brain, soporta multi-step tool calls ───────

    private suspend fun callVoiceWebhook(base64Audio: String): String =
        withContext(Dispatchers.IO) {
            try {
                // Paso 1: enviar audio + historial previo (memoria cross-comando)
                val initBody = JSONObject().apply {
                    put("audioBase64", base64Audio)
                    if (conversationHistory.isNotBlank()) put("conversationHistory", conversationHistory)
                }
                var json = postWebhook(initBody) ?: return@withContext "Error de conexión"

                var finalText = json.optString("text", "")
                var history   = json.optString("history", "")
                var maxSteps  = 3

                // Paso 2: loop de follow-up para tools que necesitan resultado del teléfono
                while (maxSteps-- > 0) {
                    val action = json.optJSONObject("androidAction") ?: break
                    val tool   = action.getString("tool")
                    val params = action.optJSONObject("params") ?: JSONObject()
                    Log.d(TAG, "androidAction: $tool | $params")

                    val toolResult = garra.execute(tool, params)
                    Log.d(TAG, "toolResult: $toolResult")

                    // Si Gemini ya dio texto de confirmación, no necesitamos follow-up
                    if (finalText.isNotBlank()) break

                    // Tools que devuelven datos que Gemini necesita → follow-up
                    val needsFollowUp = listOf("get_contacts", "list_apps", "get_battery")
                        .contains(tool)
                    if (!needsFollowUp) break

                    val followBody = JSONObject().apply {
                        put("toolName",   tool)
                        put("toolResult", toolResult)
                        put("history",    history)
                    }
                    json = postWebhook(followBody) ?: break
                    finalText = json.optString("text", "")
                    history   = json.optString("history", "")
                }

                // Actualizar memoria conversacional para el próximo comando
                val newHistory = json.optString("conversationHistory", "")
                if (newHistory.isNotBlank()) conversationHistory = newHistory

                finalText

            } catch (e: Exception) {
                Log.e(TAG, "voiceWebhook error: ${e.message}")
                "Error de conexión"
            }
        }

    private fun postWebhook(body: JSONObject): JSONObject? {
        return try {
            val conn = URL(VOICE_WEBHOOK).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.doOutput       = true
            conn.connectTimeout = 20_000
            conn.readTimeout    = 30_000
            conn.outputStream.bufferedWriter().use { it.write(body.toString()) }

            val code = conn.responseCode
            if (code != 200) {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: "sin detalle"
                Log.e(TAG, "voiceWebhook HTTP $code: $err")
                conn.disconnect()
                return null
            }
            val result = JSONObject(conn.inputStream.bufferedReader().readText())
            conn.disconnect()
            result
        } catch (e: Exception) {
            Log.e(TAG, "postWebhook error: ${e.message}")
            null
        }
    }

    // ── PCM → WAV ────────────────────────────────────────────────────────────

    private fun shortArrayToWav(samples: ShortArray): ByteArray {
        val channels      = 1
        val bitsPerSample = 16
        val byteRate      = sampleRate * channels * bitsPerSample / 8
        val dataSize      = samples.size * 2

        val buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray())
        buf.putInt(36 + dataSize)
        buf.put("WAVE".toByteArray())
        buf.put("fmt ".toByteArray())
        buf.putInt(16)
        buf.putShort(1)                                        // PCM
        buf.putShort(channels.toShort())
        buf.putInt(sampleRate)
        buf.putInt(byteRate)
        buf.putShort((channels * bitsPerSample / 8).toShort())
        buf.putShort(bitsPerSample.toShort())
        buf.put("data".toByteArray())
        buf.putInt(dataSize)
        for (s in samples) buf.putShort(s)
        return buf.array()
    }

    // ── TTS ──────────────────────────────────────────────────────────────────

    private fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jarvis")
    }

    // ── Notificación ─────────────────────────────────────────────────────────

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, JarvisMessagingService.CHANNEL_BRIEFING)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("JARVIS")
            .setContentText(text)
            .setOngoing(true)
            .build()

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(NOTIF_ID, buildNotification(text))
    }
}
