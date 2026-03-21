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
import org.vosk.Model
import org.vosk.Recognizer
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.zip.ZipInputStream

/**
 * ForegroundService de JARVIS — escucha wake word, graba comando, lo procesa
 * con Gemini (function calling) y ejecuta acciones en el teléfono vía AndroidGarra.
 *
 * Flujo completo:
 *  1. Vosk escucha continuamente → detecta "jarvis" en transcript parcial
 *  2. Graba 5 segundos de comando de voz (misma AudioRecord)
 *  3. Convierte audio a WAV → base64 → voiceWebhook Cloud Function
 *  4. Gemini devuelve tool calls → AndroidGarra los ejecuta
 *  5. Gemini genera respuesta final → TextToSpeech la habla
 *  6. Vuelve a escuchar wake word
 */
class JarvisListenerService : Service() {

    companion object {
        private const val TAG             = "JARVIS-Listener"
        private const val NOTIF_ID        = 9001
        private const val COMMAND_SECONDS = 5
        private const val SAMPLE_RATE     = 16000
        private const val FRAME_BYTES     = 4096  // bytes por frame = 2048 samples
        private const val MODEL_URL       = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
        private const val VOICE_WEBHOOK   = "https://us-central1-claw-brain-e6596.cloudfunctions.net/voiceWebhook"
    }

    private var voskModel:      Model?       = null
    private var voskRecognizer: Recognizer?  = null
    private var audioRecord:    AudioRecord? = null
    private var isListening                  = false

    // Buffer de grabación de comando (en samples)
    private val commandBuffer    = mutableListOf<Short>()
    private var commandRemaining = 0  // samples restantes por capturar

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private lateinit var garra: AndroidGarra
    private var tts: TextToSpeech? = null

    // Memoria conversacional entre comandos
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

        startForeground(NOTIF_ID, buildNotification("Iniciando..."))
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
        voskRecognizer?.close()
        voskRecognizer = null
        voskModel?.close()
        voskModel = null
        tts?.stop()
        tts?.shutdown()
        serviceScope.cancel()
        Log.d(TAG, "JarvisListenerService detenido")
    }

    // ── Wake word detection (Vosk) ───────────────────────────────────────────

    private fun startWakeWordDetection() {
        val modelDir = File(filesDir, "vosk-model")
        if (modelDir.exists() && modelDir.isDirectory) {
            initAudioAndVosk(modelDir.absolutePath)
        } else {
            updateNotification("📥 Descargando modelo de voz (primera vez ~40MB)...")
            serviceScope.launch { downloadAndExtractModel(modelDir) }
        }
    }

    private suspend fun downloadAndExtractModel(modelDir: File) = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "Descargando modelo Vosk...")
            val zipFile = File(filesDir, "vosk.zip")
            URL(MODEL_URL).openStream().use { input ->
                FileOutputStream(zipFile).use { output -> input.copyTo(output) }
            }
            Log.d(TAG, "Extrayendo modelo Vosk...")
            ZipInputStream(zipFile.inputStream()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val entryFile = File(filesDir, entry.name)
                    if (entry.isDirectory) {
                        entryFile.mkdirs()
                    } else {
                        entryFile.parentFile?.mkdirs()
                        FileOutputStream(entryFile).use { out -> zis.copyTo(out) }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
            zipFile.delete()
            // Renombrar carpeta extraída a "vosk-model"
            val extracted = filesDir.listFiles()
                ?.firstOrNull { it.isDirectory && it.name.startsWith("vosk-model-small") }
            extracted?.renameTo(modelDir)
            Log.d(TAG, "Modelo Vosk listo: ${modelDir.absolutePath}")
            withContext(Dispatchers.Main) { initAudioAndVosk(modelDir.absolutePath) }
        } catch (e: Exception) {
            Log.e(TAG, "Error descargando modelo: ${e.message}")
            updateNotification("⚠️ Error descargando modelo. Verificá internet.")
        }
    }

    private fun initAudioAndVosk(modelPath: String) {
        try {
            voskModel      = Model(modelPath)
            voskRecognizer = Recognizer(voskModel, SAMPLE_RATE.toFloat())

            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf * 2, FRAME_BYTES * 2)
            )

            isListening = true
            audioRecord!!.startRecording()
            Log.d(TAG, "Vosk OK — sampleRate=$SAMPLE_RATE")
            updateNotification("Escuchando... di \"JARVIS\"")

            serviceScope.launch { audioLoop() }
        } catch (e: Exception) {
            Log.e(TAG, "Error inicializando Vosk: ${e.message}")
            updateNotification("⚠️ Error: ${e.message}")
        }
    }

    private suspend fun audioLoop() = withContext(Dispatchers.IO) {
        val buffer = ByteArray(FRAME_BYTES)
        while (isListening) {
            val bytesRead = audioRecord?.read(buffer, 0, FRAME_BYTES) ?: break
            if (bytesRead <= 0) continue

            if (commandRemaining > 0) {
                // ── Modo grabación de comando ──────────────────────────────
                val shorts = ShortArray(bytesRead / 2)
                ByteBuffer.wrap(buffer, 0, bytesRead)
                    .order(ByteOrder.LITTLE_ENDIAN)
                    .asShortBuffer()
                    .get(shorts)
                commandBuffer.addAll(shorts.toList())
                commandRemaining -= shorts.size
                if (commandRemaining <= 0) {
                    val samples = commandBuffer.toShortArray()
                    commandBuffer.clear()
                    serviceScope.launch { processCommand(samples) }
                }
            } else {
                // ── Modo detección wake word ───────────────────────────────
                val accepted = voskRecognizer?.acceptWaveForm(buffer, bytesRead) ?: false
                val partial = try {
                    if (accepted) {
                        JSONObject(voskRecognizer?.result ?: "{}").optString("text", "")
                    } else {
                        JSONObject(voskRecognizer?.partialResult ?: "{}").optString("partial", "")
                    }
                } catch (e: Exception) { "" }

                if (partial.isNotBlank()) Log.d(TAG, "Vosk escucha: '$partial'")

                // "jarvis" en pronunciación argentina suena como "jair", "harvey", "jar" para el modelo inglés
                val lower = partial.lowercase()
                val wakeDetected = lower.contains("jarvis") ||
                    lower.contains("jair")   ||
                    lower.contains("harvey") ||
                    lower.contains("jar vis")
                if (wakeDetected) {
                    Log.d(TAG, "🎤 Wake word detectado: '$partial'")
                    voskRecognizer?.reset()
                    withContext(Dispatchers.Main) { onWakeWordDetected() }
                }
            }
        }
    }

    private fun onWakeWordDetected() {
        updateNotification("🎤 Escuchando comando...")
        speak("Sí")
        commandBuffer.clear()
        commandRemaining = SAMPLE_RATE * COMMAND_SECONDS
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

    // ── voiceWebhook ─────────────────────────────────────────────────────────

    private suspend fun callVoiceWebhook(base64Audio: String): String =
        withContext(Dispatchers.IO) {
            try {
                val initBody = JSONObject().apply {
                    put("audioBase64", base64Audio)
                    if (conversationHistory.isNotBlank()) put("conversationHistory", conversationHistory)
                }
                var json = postWebhook(initBody) ?: return@withContext "Error de conexión"

                var finalText = json.optString("text", "")
                var history   = json.optString("history", "")
                var maxSteps  = 3

                while (maxSteps-- > 0) {
                    val action = json.optJSONObject("androidAction") ?: break
                    val tool   = action.getString("tool")
                    val params = action.optJSONObject("params") ?: JSONObject()
                    Log.d(TAG, "androidAction: $tool | $params")

                    val toolResult = garra.execute(tool, params)
                    Log.d(TAG, "toolResult: $toolResult")

                    if (finalText.isNotBlank()) break

                    val needsFollowUp = listOf("get_contacts", "list_apps", "get_battery").contains(tool)
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
        val byteRate      = SAMPLE_RATE * channels * bitsPerSample / 8
        val dataSize      = samples.size * 2

        val buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray())
        buf.putInt(36 + dataSize)
        buf.put("WAVE".toByteArray())
        buf.put("fmt ".toByteArray())
        buf.putInt(16)
        buf.putShort(1)
        buf.putShort(channels.toShort())
        buf.putInt(SAMPLE_RATE)
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
