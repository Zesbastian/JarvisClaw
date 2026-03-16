package com.secureclaw.jarvis

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import ai.picovoice.porcupine.Porcupine
import ai.picovoice.porcupine.PorcupineException
import kotlinx.coroutines.*

/**
 * ForegroundService que escucha continuamente el wake word "JARVIS".
 * Usa Porcupine built-in keyword — no requiere archivo .ppn externo.
 *
 * Flujo:
 *  1. Servicio arranca → notificación persistente "Escuchando..."
 *  2. Porcupine procesa audio del micrófono frame a frame
 *  3. Al detectar "JARVIS" → llama a onWakeWordDetected()
 *  4. onWakeWordDetected → pausa escucha → inicia grabación de comando (Fase 8.3)
 */
class JarvisListenerService : Service() {

    companion object {
        private const val TAG        = "JARVIS-Listener"
        private const val NOTIF_ID   = 9001
        // AccessKey de Picovoice — obtener en https://console.picovoice.ai/
        // Reemplazar antes de compilar. NUNCA hardcodear en producción.
        private const val ACCESS_KEY = "YOUR_PICOVOICE_ACCESS_KEY_HERE"
    }

    private var porcupine: Porcupine? = null
    private var audioRecord: AudioRecord? = null
    private var isListening = false
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "JarvisListenerService iniciado")
        if (ACCESS_KEY == "YOUR_PICOVOICE_ACCESS_KEY_HERE" || ACCESS_KEY.isBlank()) {
            Log.w(TAG, "Wake word desactivado — AccessKey no configurada (pendiente Picovoice)")
            startForeground(NOTIF_ID, buildForegroundNotification("JARVIS activo"))
            return START_NOT_STICKY  // No reiniciar automáticamente
        }
        startForeground(NOTIF_ID, buildForegroundNotification("Escuchando... di \"JARVIS\""))
        startWakeWordDetection()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        stopWakeWordDetection()
        serviceScope.cancel()
        Log.d(TAG, "JarvisListenerService detenido")
    }

    // ── Inicializar Porcupine y loop de audio ────────────────────────────────
    private fun startWakeWordDetection() {
        try {
            porcupine = Porcupine.Builder()
                .setAccessKey(ACCESS_KEY)
                .setKeyword(Porcupine.BuiltInKeyword.JARVIS)
                .setSensitivity(0.7f)
                .build(applicationContext)

            val sampleRate  = porcupine!!.sampleRate
            val frameLength = porcupine!!.frameLength

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) * 2
            )

            isListening = true
            audioRecord!!.startRecording()
            Log.d(TAG, "Porcupine iniciado — sampleRate=$sampleRate frameLength=$frameLength")

            serviceScope.launch {
                val buffer = ShortArray(frameLength)
                while (isListening) {
                    val read = audioRecord?.read(buffer, 0, frameLength) ?: break
                    if (read == frameLength) {
                        val result = porcupine?.process(buffer) ?: break
                        if (result >= 0) {
                            Log.d(TAG, "🎤 Wake word detectado!")
                            onWakeWordDetected()
                        }
                    }
                }
            }

        } catch (e: PorcupineException) {
            Log.e(TAG, "Error inicializando Porcupine: ${e.message}")
        }
    }

    private fun stopWakeWordDetection() {
        isListening = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        porcupine?.delete()
        porcupine = null
    }

    // ── Wake word detectado ──────────────────────────────────────────────────
    private fun onWakeWordDetected() {
        Log.d(TAG, "Wake word detectado — pausando escucha")

        // Actualizar notificación
        updateNotification("🎤 Escuchando comando...")

        // TODO Fase 8.3: pausar Porcupine → grabar comando → enviar al Brain
        // Por ahora: log + volver a escuchar después de 3 segundos
        serviceScope.launch {
            delay(3000)
            updateNotification("Escuchando... di \"JARVIS\"")
            Log.d(TAG, "Volviendo a escuchar wake word")
        }
    }

    // ── Notificación foreground ──────────────────────────────────────────────
    private fun buildForegroundNotification(text: String): Notification {
        return NotificationCompat.Builder(this, JarvisMessagingService.CHANNEL_BRIEFING)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("JARVIS")
            .setContentText(text)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildForegroundNotification(text))
    }
}
