package com.secureclaw.jarvis

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.util.Log
import android.view.KeyEvent
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
                "open_maps"      -> openMaps(
                    params.getString("query"),
                    params.optBoolean("navigate", false)
                )
                "music_control"  -> musicControl(
                    params.getString("action"),
                    params.optString("query", "")
                )
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
        val wa = normalizeForWhatsApp(phone)
        Log.d(TAG, "sendWhatsApp: phone='$phone' → normalizado='$wa'")
        val uri = Uri.parse("whatsapp://send?phone=$wa&text=${Uri.encode(message)}")
        // Intentar WhatsApp normal, luego WhatsApp Business, luego sin package fijo
        val packages = listOf("com.whatsapp", "com.whatsapp.w4b", null)
        for (pkg in packages) {
            try {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    if (pkg != null) setPackage(pkg)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                Log.d(TAG, "sendWhatsApp: abierto con pkg=$pkg")
                return "WhatsApp abierto para $wa — tocá Enviar"
            } catch (e: Exception) {
                Log.w(TAG, "sendWhatsApp: falló con pkg=$pkg → ${e.message}")
            }
        }
        return "No se pudo abrir WhatsApp"
    }

    /**
     * Normaliza un número de teléfono argentino al formato internacional para WhatsApp.
     * WhatsApp espera: 549XXXXXXXXXX (sin +, sin 0, con 9 para móviles AR)
     * Ejemplos de entrada:
     *   "0261 400-1234"   → "5492614001234"
     *   "+54 9 261 400 1234" → "549261401234"  (ya tiene 9)
     *   "2614001234"      → "5492614001234"
     */
    private fun normalizeForWhatsApp(phone: String): String {
        // Solo dígitos
        var digits = phone.replace(Regex("[^\\d]"), "")
        // Si empieza con 54 (código país) → verificar si tiene el 9 de móvil
        if (digits.startsWith("54")) {
            digits = if (digits.length > 2 && digits[2] == '9') digits else "54" + "9" + digits.substring(2)
            return digits
        }
        // Si empieza con 0 (marcación nacional) → quitar 0, agregar 549
        if (digits.startsWith("0")) digits = digits.substring(1)
        // Si lo que queda es 10 dígitos → número local sin código país
        return if (digits.length == 10) "549$digits" else digits
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
        return if (phone.isNotBlank()) {
            // ACTION_CALL inicia la llamada directamente (requiere CALL_PHONE)
            val intent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:$phone")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            "Llamando a $phone"
        } else {
            // Sin número: abre el marcador vacío
            val intent = Intent(Intent.ACTION_DIAL).apply {
                data = Uri.parse("tel:")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            "Marcador abierto"
        }
    }

    private fun normalizeText(s: String): String =
        s.lowercase()
            .replace("á","a").replace("é","e").replace("í","i")
            .replace("ó","o").replace("ú","u").replace("ü","u")
            .replace("ñ","n")

    private suspend fun getContacts(query: String): String = withContext(Dispatchers.IO) {
        val allContacts = mutableListOf<String>()

        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            ),
            null, null,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
        )?.use { cursor ->
            val nameIdx  = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val phoneIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext()) {
                allContacts.add("${cursor.getString(nameIdx)}: ${cursor.getString(phoneIdx)}")
            }
        }

        // Filtrar en Kotlin con normalización de acentos (SQL LIKE no maneja tildes)
        val results = if (query.isNotBlank()) {
            val q = normalizeText(query)
            allContacts.filter { normalizeText(it).contains(q) }.take(10)
        } else {
            allContacts.take(50)
        }

        if (results.isEmpty()) "No se encontraron contactos con '$query'" else results.joinToString("\n")
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

    private fun openMaps(query: String, navigate: Boolean): String {
        val uri = if (navigate) {
            // Navegación GPS al lugar
            Uri.parse("google.navigation:q=${Uri.encode(query)}&mode=d")
        } else {
            // Búsqueda en Maps (hamburguesas cerca, hospital, etc.)
            Uri.parse("geo:0,0?q=${Uri.encode(query)}")
        }
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return if (navigate) "Navegando hacia $query" else "Buscando '$query' en Maps"
    }

    private fun musicControl(action: String, query: String): String {
        // Si piden una búsqueda específica (artista, canción) → abrir Spotify con deep link
        if (query.isNotBlank() && action == "play") {
            try {
                val uri = Uri.parse("spotify:search:${Uri.encode(query)}")
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                return "Buscando '$query' en Spotify"
            } catch (e: Exception) {
                Log.w(TAG, "musicControl: Spotify deep link falló → ${e.message}")
            }
        }
        // Controlar reproducción con teclas de media (funciona con Spotify, YouTube Music, etc.)
        val keyCode = when (action) {
            "play", "pause" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            "next"          -> KeyEvent.KEYCODE_MEDIA_NEXT
            "prev"          -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop"          -> KeyEvent.KEYCODE_MEDIA_STOP
            else            -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
        }
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
        return "Música: $action"
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
        put(funcDef(
            "open_maps",
            "Abre Google Maps para navegar a un lugar o buscar lugares cercanos",
            props(
                "query"    to ("string"  to "Lugar, dirección o búsqueda. Ej: 'pizzería', 'Hospital Central Mendoza', 'casa de mamá'"),
                "navigate" to ("boolean" to "true para iniciar navegación GPS, false para solo buscar en el mapa")
            ),
            required = listOf("query")
        ))
        put(funcDef(
            "music_control",
            "Controla la música del teléfono. Puede reproducir, pausar, siguiente canción, o buscar música de un artista en Spotify.",
            props(
                "action" to ("string" to "Acción: 'play', 'pause', 'next', 'prev', 'stop'"),
                "query"  to ("string" to "Artista o canción a buscar en Spotify (opcional, solo para action=play)")
            ),
            required = listOf("action")
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
