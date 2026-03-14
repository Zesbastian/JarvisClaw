package com.secureclaw.jarvis

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.google.firebase.firestore.FirebaseFirestore

class JarvisMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "JARVIS-FCM"
        const val CHANNEL_BRIEFING = "jarvis_briefing"
        const val CHANNEL_HITL     = "jarvis_hitl"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    // Se llama cuando Firebase renueva el token — lo actualizamos en Firestore
    override fun onNewToken(token: String) {
        Log.d(TAG, "FCM token renovado: $token")
        FirebaseFirestore.getInstance()
            .collection("AndroidDevices")
            .document("primary")
            .update(mapOf(
                "fcmToken" to token,
                "updatedAt" to System.currentTimeMillis()
            ))
    }

    // Se llama cuando llega una notificación (briefing, alerta, HITL)
    override fun onMessageReceived(message: RemoteMessage) {
        Log.d(TAG, "FCM recibido: ${message.data}")

        val type = message.data["type"] ?: "notification"

        when (type) {
            "briefing" -> showBriefingNotification(message)
            "hitl"     -> showHitlNotification(message)
            else       -> showGenericNotification(message)
        }
    }

    // ── Briefing matutino ─────────────────────────────────────────────────────
    private fun showBriefingNotification(message: RemoteMessage) {
        val title = message.data["title"] ?: "☀️ Buenos días"
        val body  = message.data["body"]  ?: ""

        val intent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_BRIEFING)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()

        getSystemService(NotificationManager::class.java)
            .notify(1001, notification)
    }

    // ── HITL: Aprobar / Denegar desde notificación nativa ────────────────────
    private fun showHitlNotification(message: RemoteMessage) {
        val jobId = message.data["jobId"] ?: return
        val tool  = message.data["tool"]  ?: "acción"
        val desc  = message.data["description"] ?: tool

        val approveIntent = PendingIntent.getBroadcast(
            this, jobId.hashCode(),
            Intent(this, HitlActionReceiver::class.java).apply {
                action = "APPROVE"
                putExtra("jobId", jobId)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val denyIntent = PendingIntent.getBroadcast(
            this, jobId.hashCode() + 1,
            Intent(this, HitlActionReceiver::class.java).apply {
                action = "DENY"
                putExtra("jobId", jobId)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_HITL)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("⚠️ JARVIS solicita permiso")
            .setContentText(desc)
            .setStyle(NotificationCompat.BigTextStyle().bigText(desc))
            .addAction(android.R.drawable.ic_menu_send, "✅ Aprobar", approveIntent)
            .addAction(android.R.drawable.ic_delete, "🛑 Denegar", denyIntent)
            .setAutoCancel(true)
            .build()

        getSystemService(NotificationManager::class.java)
            .notify(jobId.hashCode(), notification)
    }

    private fun showGenericNotification(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "JARVIS"
        val body  = message.notification?.body  ?: message.data["body"]  ?: ""

        val notification = NotificationCompat.Builder(this, CHANNEL_BRIEFING)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()

        getSystemService(NotificationManager::class.java)
            .notify(System.currentTimeMillis().toInt(), notification)
    }

    private fun createNotificationChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_BRIEFING, "Briefing matutino", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Resumen diario de clima y agenda" }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_HITL, "Aprobaciones JARVIS", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "Solicitudes de acceso a tu PC" }
        )
    }
}
