package com.secureclaw.jarvis

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "JARVIS-Main"
        private const val REQUEST_PERMISSIONS = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        requestRequiredPermissions()
        registerFcmToken()
        startJarvisListener()
    }

    private fun startJarvisListener() {
        val intent = Intent(this, JarvisListenerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        Log.d(TAG, "JarvisListenerService arrancado")
    }

    private fun requestRequiredPermissions() {
        val permissions = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.RECORD_AUDIO)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (permissions.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, permissions.toTypedArray(), REQUEST_PERMISSIONS)
        }
    }

    private fun registerFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w(TAG, "No se pudo obtener el token FCM", task.exception)
                return@addOnCompleteListener
            }
            val token = task.result
            Log.d(TAG, "FCM Token: $token")

            // Guardar token en Firestore para que el Brain pueda enviar notificaciones
            FirebaseFirestore.getInstance()
                .collection("AndroidDevices")
                .document("primary")
                .set(mapOf(
                    "fcmToken" to token,
                    "updatedAt" to System.currentTimeMillis()
                ))
                .addOnSuccessListener {
                    Log.d(TAG, "FCM token registrado en Firestore")
                    updateStatusText("✅ JARVIS conectado")
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "Error registrando FCM token", e)
                    updateStatusText("⚠️ Error de conexión")
                }
        }
    }

    private fun updateStatusText(text: String) {
        runOnUiThread {
            findViewById<TextView>(R.id.tvStatus)?.text = text
        }
    }
}
