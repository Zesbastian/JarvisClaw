package com.secureclaw.jarvis

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "JARVIS-Main"
        private const val REQUEST_PERMISSIONS = 1001
    }

    private val healthManager by lazy { HealthSyncManager(this) }

    // Contrato correcto para Health Connect
    private val healthPermissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        if (granted.containsAll(HealthSyncManager.REQUIRED_PERMISSIONS)) {
            Log.d(TAG, "Permisos Health Connect otorgados — sincronizando")
            syncHealth()
        } else {
            Log.w(TAG, "Permisos Health Connect parcialmente denegados")
            syncHealth() // intentar igual con los que tenga
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        registerFcmToken()

        // SYSTEM_ALERT_WINDOW — permite al ForegroundService lanzar actividades (abrir apps, alarmas, etc.)
        // Sin este permiso, startActivity() desde JarvisListenerService falla silenciosamente en Android 10+
        if (!Settings.canDrawOverlays(this)) {
            Log.w(TAG, "Permiso overlay no concedido — pidiendo al usuario")
            updateStatusText("⚠️ JARVIS necesita permiso 'Mostrar sobre otras apps'")
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
        }

        // Micrófono: necesario antes de arrancar el ForegroundService
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED) {
            startJarvisListener()
        } else {
            requestRequiredPermissions()
        }

        initHealthConnect()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS) {
            val audioIndex = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
            if (audioIndex >= 0 && grantResults[audioIndex] == PackageManager.PERMISSION_GRANTED) {
                startJarvisListener()
            } else {
                Log.w(TAG, "RECORD_AUDIO denegado — servicio de escucha no iniciado")
                updateStatusText("⚠️ Micrófono requerido para wake word")
            }
        }
    }

    private fun initHealthConnect() {
        lifecycleScope.launch {
            try {
                if (!healthManager.isAvailable()) {
                    Log.w(TAG, "Health Connect no disponible")
                    return@launch
                }
                // Intentamos sincronizar directamente. Si el usuario ya otorgó permisos
                // en la app HC, las operaciones van a funcionar. Si no, cada bloque
                // falla silenciosamente con su propio try-catch.
                syncHealth()
            } catch (e: Exception) {
                Log.e(TAG, "Error iniciando Health Connect: ${e.message}")
            }
        }
    }

    private fun syncHealth() {
        lifecycleScope.launch {
            try {
                healthManager.syncToday()
                Log.d(TAG, "Health sync completado")
            } catch (e: Exception) {
                Log.e(TAG, "Error en health sync: ${e.message}")
            }
        }
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
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.CALL_PHONE
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        ActivityCompat.requestPermissions(this, permissions.toTypedArray(), REQUEST_PERMISSIONS)
    }

    private fun registerFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w(TAG, "No se pudo obtener el token FCM", task.exception)
                return@addOnCompleteListener
            }
            val token = task.result
            Log.d(TAG, "FCM Token obtenido")

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
