package com.secureclaw.jarvis

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Garra Android — ejecuta acciones en el teléfono a partir de tool calls de Gemini.
 * Equivalente móvil de garra.js en la PC.
 */
class AndroidGarra(private val context: Context) {

    companion object {
        private const val TAG = "JARVIS-Garra"
    }

    // ── Dispatcher principal ─────────────────────────────────────────────────

    suspend fun execute(toolName: String, params: JSONObject): String {
        Log.d(TAG, "Tool: $toolName | params: $params")
        return try {
            when (toolName) {
                "open_app"       -> openApp(params.getString("package_name"))
                "send_whatsapp"  -> sendWhatsApp(params.getString("phone"), params.getString("message"))
                "send_sms"       -> sendSms(params.getString("phone"), params.getString("message"))
                "make_call"      -> makeCall(params.getString("phone"))
                "get_contacts"   -> getContacts(params.optString("query", ""))
                "set_alarm"      -> setAlarm(
                    params.getInt("hour"),
                    params.getInt("minute"),
                    params.optString("label", "JARVIS")
                )
                "get_battery"    -> getBattery()
                "list_apps"      -> listApps()
                "open_camera"    -> openCamera()
                else             -> "Tool desconocido: $toolName"
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error en $toolName: ${e.message}")
            "Error ejecutando $toolName: ${e.message}"
        }
    }

    // ── Implementaciones ─────────────────────────────────────────────────────

    private fun openApp(packageName: String): String {
        val pm = context.packageManager

        // Intento 1: package name exacto
        var intent = pm.getLaunchIntentForPackage(packageName)

        // Intento 2: buscar por nombre de app o parte del package (Gemini puede mandar nombre en vez de package)
        if (intent == null) {
            val query = packageName.lowercase()
            val match = pm.getInstalledApplications(PackageManager.GET_META_DATA).firstOrNull { app ->
                val label = pm.getApplicationLabel(app).toString().lowercase()
                label.contains(query) || app.packageName.lowercase().contains(query)
            }
            if (match != null) {
                Log.d(TAG, "openApp: '$packageName' → encontrado como '${match.packageName}'")
                intent = pm.getLaunchIntentForPackage(match.packageName)
            }
        }

        if (intent == null) {
            Log.w(TAG, "openApp: no encontrada '$packageName'")
            return "App no encontrada: $packageName"
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return "Abriendo $packageName"
    }

    private fun sendWhatsApp(phone: String, message: String): String {
        // Limpia el número: solo dígitos y +
        val clean = phone.replace(Regex("[^\\d+]"), "")
        // URI scheme directo — no pasa por navegador
        val uri = Uri.parse("whatsapp://send?phone=$clean&text=${Uri.encode(message)}")
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            setPackage("com.whatsapp")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return "WhatsApp abierto con mensaje para $clean"
    }

    private fun sendSms(phone: String, message: String): String {
        val intent = Intent(Intent.ACTION_SENDTO).apply {
            data = Uri.parse("smsto:$phone")
            putExtra("sms_body", message)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return "SMS abierto para $phone"
    }

    private fun makeCall(phone: String): String {
        val intent = Intent(Intent.ACTION_DIAL).apply {
            data = Uri.parse("tel:$phone")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return "Marcando $phone"
    }

    private suspend fun getContacts(query: String): String = withContext(Dispatchers.IO) {
        val results = mutableListOf<String>()
        val selection = if (query.isNotBlank()) {
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
        } else null
        val selectionArgs = if (query.isNotBlank()) arrayOf("%$query%") else null

        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            ),
            selection,
            selectionArgs,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
        )?.use { cursor ->
            val nameIdx  = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val phoneIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext() && results.size < 50) {
                results.add("${cursor.getString(nameIdx)}: ${cursor.getString(phoneIdx)}")
            }
        }
        if (results.isEmpty()) "No se encontraron contactos" else results.joinToString("\n")
    }

    private fun setAlarm(hour: Int, minute: Int, label: String): String {
        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, hour)
            putExtra(AlarmClock.EXTRA_MINUTES, minute)
            putExtra(AlarmClock.EXTRA_MESSAGE, label)
            // EXTRA_SKIP_UI=true no funciona en MIUI — abrimos la UI para confirmar
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        context.startActivity(intent)
        return "Alarma para las $hour:${minute.toString().padStart(2, '0')}"
    }

    private fun openCamera(): String {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        context.startActivity(intent)
        return "Cámara abierta"
    }

    private fun getBattery(): String {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level     = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging  = bm.isCharging
        return "Batería: $level% — ${if (charging) "cargando" else "descargando"}"
    }

    private suspend fun listApps(): String = withContext(Dispatchers.IO) {
        val pm = context.packageManager
        pm.getInstalledApplications(0)
            .mapNotNull { app ->
                val label = pm.getApplicationLabel(app).toString()
                if (label.isNotBlank() &&
                    !app.packageName.startsWith("com.android") &&
                    !app.packageName.startsWith("android")) {
                    "$label (${app.packageName})"
                } else null
            }
            .take(40)
            .joinToString("\n")
    }

    // ── Tool definitions para Gemini function calling ────────────────────────

    fun getToolDefinitions(): JSONArray = JSONArray().apply {
        put(funcDef(
            "open_app",
            "Abre una aplicación instalada en el teléfono de Sebastián",
            props(
                "package_name" to ("string" to "Package name de la app. Ejemplos: com.whatsapp, com.instagram.android, com.spotify.music, com.netflix.mediaclient")
            ),
            required = listOf("package_name")
        ))
        put(funcDef(
            "send_whatsapp",
            "Abre WhatsApp con un mensaje pre-escrito listo para enviar a un número o contacto",
            props(
                "phone"   to ("string" to "Número con código de país, ej: 5492615551234"),
                "message" to ("string" to "El texto del mensaje")
            ),
            required = listOf("phone", "message")
        ))
        put(funcDef(
            "send_sms",
            "Abre la app de mensajes con número y texto listos para enviar",
            props(
                "phone"   to ("string" to "Número de teléfono"),
                "message" to ("string" to "El texto del SMS")
            ),
            required = listOf("phone", "message")
        ))
        put(funcDef(
            "make_call",
            "Abre el marcador del teléfono con el número listo para llamar",
            props(
                "phone" to ("string" to "Número de teléfono")
            ),
            required = listOf("phone")
        ))
        put(funcDef(
            "get_contacts",
            "Busca contactos en la agenda del teléfono",
            props(
                "query" to ("string" to "Nombre o parte del nombre a buscar. Dejar vacío para listar todos")
            ),
            required = listOf()
        ))
        put(funcDef(
            "set_alarm",
            "Configura una alarma en el reloj del teléfono",
            props(
                "hour"   to ("integer" to "Hora en formato 24h (0-23)"),
                "minute" to ("integer" to "Minutos (0-59)"),
                "label"  to ("string"  to "Etiqueta opcional para la alarma")
            ),
            required = listOf("hour", "minute")
        ))
        put(funcDef(
            "get_battery",
            "Obtiene el nivel de batería y estado de carga del teléfono",
            props(),
            required = listOf()
        ))
        put(funcDef(
            "list_apps",
            "Lista las aplicaciones instaladas en el teléfono",
            props(),
            required = listOf()
        ))
        put(funcDef(
            "open_camera",
            "Abre la cámara del teléfono para tomar una foto",
            props(),
            required = listOf()
        ))
    }

    // ── Helpers para construir el schema ─────────────────────────────────────

    private fun funcDef(
        name: String,
        description: String,
        properties: JSONObject,
        required: List<String>
    ): JSONObject = JSONObject().apply {
        put("name", name)
        put("description", description)
        put("parameters", JSONObject().apply {
            put("type", "object")
            put("properties", properties)
            if (required.isNotEmpty()) {
                put("required", JSONArray(required))
            }
        })
    }

    private fun props(vararg pairs: Pair<String, Pair<String, String>>): JSONObject =
        JSONObject().apply {
            pairs.forEach { (key, typeDesc) ->
                put(key, JSONObject().apply {
                    put("type", typeDesc.first)
                    put("description", typeDesc.second)
                })
            }
        }
}
