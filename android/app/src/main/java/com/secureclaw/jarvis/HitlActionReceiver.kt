package com.secureclaw.jarvis

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.firestore.FirebaseFirestore

/**
 * Recibe los intents de los botones "Aprobar" / "Denegar" de las notificaciones HITL.
 * Actualiza el PC_Job en Firestore directamente — sin pasar por Telegram.
 */
class HitlActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "JARVIS-HITL"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val jobId  = intent.getStringExtra("jobId") ?: return
        val action = intent.action ?: return

        val newStatus = when (action) {
            "APPROVE" -> "approved"
            "DENY"    -> "denied"
            else      -> return
        }

        Log.d(TAG, "HITL $action para job $jobId → status=$newStatus")

        FirebaseFirestore.getInstance()
            .collection("PC_Jobs")
            .document(jobId)
            .update("status", newStatus)
            .addOnSuccessListener {
                Log.d(TAG, "PC_Job $jobId actualizado a $newStatus")
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Error actualizando PC_Job $jobId", e)
            }

        // Descartar la notificación
        context.getSystemService(NotificationManager::class.java)
            .cancel(jobId.hashCode())
    }
}
