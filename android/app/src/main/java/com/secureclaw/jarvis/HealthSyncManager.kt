package com.secureclaw.jarvis

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessaging
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

class HealthSyncManager(private val context: Context) {

    companion object {
        private const val TAG = "JARVIS-Health"

        val REQUIRED_PERMISSIONS = setOf(
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class), // requiere READ_SLEEP en manifest
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class)
        )
    }

    private val healthClient by lazy { HealthConnectClient.getOrCreate(context) }
    private val db = FirebaseFirestore.getInstance()
    private val tz = ZoneId.of("America/Argentina/Mendoza")

    suspend fun isAvailable(): Boolean {
        return try {
            val status = HealthConnectClient.getSdkStatus(context)
            Log.d(TAG, "HC getSdkStatus=$status (SDK_AVAILABLE=${HealthConnectClient.SDK_AVAILABLE})")
            status == HealthConnectClient.SDK_AVAILABLE
        } catch (e: Exception) {
            Log.w(TAG, "HC no disponible: ${e.message}")
            false
        }
    }

    suspend fun hasPermissions(): Boolean {
        return try {
            val granted = healthClient.permissionController.getGrantedPermissions()
            granted.containsAll(REQUIRED_PERMISSIONS)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Lee los datos de salud del día de hoy y los sincroniza a Firestore.
     * El Brain los lee para el briefing y proactividad.
     */
    suspend fun syncToday() {
        if (!isAvailable()) {
            Log.w(TAG, "Health Connect no disponible")
            return
        }
        // No verificamos hasPermissions() porque el SDK 1.0.0-alpha usa formato de permisos
        // diferente al provider moderno. Ejecutamos directamente — cada bloque tiene try-catch.

        try {
            val today = LocalDate.now(tz)
            val startOfDay = today.atStartOfDay(tz).toInstant()
            val now = Instant.now()
            val yesterday = today.minusDays(1).atStartOfDay(tz).toInstant()

            val data = mutableMapOf<String, Any>()

            // ── Pasos de hoy ──────────────────────────────────────────────────
            try {
                val stepsResult = healthClient.aggregate(
                    AggregateRequest(
                        metrics = setOf(StepsRecord.COUNT_TOTAL),
                        timeRangeFilter = TimeRangeFilter.between(startOfDay, now)
                    )
                )
                val steps = stepsResult[StepsRecord.COUNT_TOTAL] ?: 0L
                data["steps_today"] = steps
                data["steps_goal"] = 10000L
                Log.d(TAG, "Pasos hoy: $steps")
            } catch (e: Exception) {
                Log.w(TAG, "No se pudieron leer pasos: ${e.message}")
            }

            // ── Sueño de anoche ───────────────────────────────────────────────
            try {
                val sleepResult = healthClient.readRecords(
                    ReadRecordsRequest(
                        recordType = SleepSessionRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(yesterday, startOfDay)
                    )
                )
                if (sleepResult.records.isNotEmpty()) {
                    val totalMinutes = sleepResult.records.sumOf {
                        ChronoUnit.MINUTES.between(it.startTime, it.endTime)
                    }
                    data["sleep_minutes_last_night"] = totalMinutes
                    data["sleep_hours_last_night"] = totalMinutes / 60.0
                    Log.d(TAG, "Sueño anoche: ${totalMinutes / 60}h ${totalMinutes % 60}min")
                }
            } catch (e: Exception) {
                Log.w(TAG, "No se pudo leer sueño: ${e.message}")
            }

            // ── Frecuencia cardíaca promedio de hoy ───────────────────────────
            try {
                val hrResult = healthClient.aggregate(
                    AggregateRequest(
                        metrics = setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX),
                        timeRangeFilter = TimeRangeFilter.between(startOfDay, now)
                    )
                )
                hrResult[HeartRateRecord.BPM_AVG]?.let { data["heart_rate_avg"] = it }
                hrResult[HeartRateRecord.BPM_MIN]?.let { data["heart_rate_min"] = it }
                hrResult[HeartRateRecord.BPM_MAX]?.let { data["heart_rate_max"] = it }
            } catch (e: Exception) {
                Log.w(TAG, "No se pudo leer frecuencia cardíaca: ${e.message}")
            }

            // ── Calorías quemadas hoy ─────────────────────────────────────────
            try {
                val calResult = healthClient.aggregate(
                    AggregateRequest(
                        metrics = setOf(TotalCaloriesBurnedRecord.ENERGY_TOTAL),
                        timeRangeFilter = TimeRangeFilter.between(startOfDay, now)
                    )
                )
                calResult[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let {
                    data["calories_today"] = it.inKilocalories.toLong()
                }
            } catch (e: Exception) {
                Log.w(TAG, "No se pudieron leer calorías: ${e.message}")
            }

            data["last_sync"] = com.google.firebase.Timestamp.now()
            data["date"] = today.toString()

            // ── Subir a Firestore ─────────────────────────────────────────────
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                db.collection("HealthData").document(token)
                    .set(data)
                    .addOnSuccessListener { Log.d(TAG, "Salud sincronizada a Firestore") }
                    .addOnFailureListener { Log.e(TAG, "Error sincronizando salud", it) }
            }

        } catch (e: Exception) {
            Log.e(TAG, "Error general en syncToday: ${e.message}")
        }
    }
}
