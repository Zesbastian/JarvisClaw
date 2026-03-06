/**
 * wake_word.js
 * Motor de detección de Wake Word ("Jarvis") usando Porcupine de PicoVoice.
 * No consume ninguna API de Gemini. Corre 100% local y gratuito.
 * Usa FFmpeg para capturar el micrófono y hace streaming de PCM crudo a Porcupine.
 */
import 'dotenv/config';
import { Porcupine, BuiltinKeyword } from '@picovoice/porcupine-node';
import { spawn } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { EventEmitter } from 'events';

// Dispositivo de micrófono (mismo que el STT)
const MIC_DEVICE = 'Micrófono (Realtek High Definition Audio)';
const PICOVOICE_KEY = process.env.PICOVOICE_KEY;

class WakeWordListener extends EventEmitter {
    constructor() {
        super();
        this.porcupine = null;
        this.ffmpegProcess = null;
        this.isListening = false;
        this.buffer = Buffer.alloc(0);
    }

    start() {
        if (this.isListening) return;

        console.log('\n👂 (JARVIS): Escuchando en segundo plano... Di "Jarvis" para activarme.');

        // Inicializar el motor Porcupine con la wake word JARVIS incorporada
        this.porcupine = new Porcupine(
            PICOVOICE_KEY,
            [BuiltinKeyword.JARVIS],    // Keyword integrado - no requiere .ppn externo
            [0.9]                        // Sensibilidad alta para mejor detección (0.9)
        );

        const frameLength = this.porcupine.frameLength;         // Número de samples por frame (512)
        const sampleRate = this.porcupine.sampleRate;           // 16000 Hz
        const bytesPerFrame = frameLength * 2;                   // 2 bytes por sample Int16

        // FFmpeg captura el micrófono y emite PCM crudo por stdout (sin archivo temporal)
        this.ffmpegProcess = spawn(ffmpegInstaller.path, [
            '-f', 'dshow',
            '-i', `audio=${MIC_DEVICE}`,
            '-ar', String(sampleRate),
            '-ac', '1',
            '-f', 's16le',     // Formato crudo: PCM 16-bit little-endian
            '-loglevel', 'quiet',
            'pipe:1'           // Salida estándar (stdout) en lugar de un archivo
        ]);

        this.isListening = true;

        let frameCount = 0;
        this.ffmpegProcess.stdout.on('data', (chunk) => {
            if (!this.isListening) return;
            frameCount++;
            if (frameCount === 50) console.log('[Wake Word]: Audio fluyendo correctamente al motor Porcupine ✅');

            // Acumular buffer hasta tener al menos un frame completo
            this.buffer = Buffer.concat([this.buffer, chunk]);

            while (this.buffer.length >= bytesPerFrame) {
                const frameBuffer = this.buffer.subarray(0, bytesPerFrame);
                this.buffer = this.buffer.subarray(bytesPerFrame);

                // Convertir a Int16Array que Porcupine necesita
                const int16Frame = new Int16Array(frameBuffer.buffer, frameBuffer.byteOffset, frameLength);
                const keywordIndex = this.porcupine.process(int16Frame);

                if (keywordIndex >= 0) {
                    // ¡Se detectó "Jarvis"!
                    console.log('\n🔥 (WAKE WORD DETECTADA): ¡Jarvis activado!');
                    this.emit('wakeWord');
                }
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            // Ignorado (FFmpeg siempre escribe info de inicio a stderr)
        });

        this.ffmpegProcess.on('close', (code) => {
            if (this.isListening) {
                console.warn('\n⚠️ FFmpeg cerró inesperadamente. Reiniciando escucha...');
                this.isListening = false;
                setTimeout(() => this.start(), 2000); // Reiniciar tras 2s
            }
        });
    }

    stop() {
        this.isListening = false;
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM');
            this.ffmpegProcess = null;
        }
        if (this.porcupine) {
            this.porcupine.release();
            this.porcupine = null;
        }
        this.buffer = Buffer.alloc(0);
        console.log('\n💤 (JARVIS): Escucha de fondo detenida.');
    }
}

export default new WakeWordListener();
