import { spawn } from 'child_process';

class TTSService {
    constructor() {
        this.isSpeaking = false;
        this.currentProcess = null;
    }

    /**
     * Usa la API nativa SAPI de Windows mediante PowerShell para hablar.
     * @param {string} text - El texto a pronunciar.
     */
    speak(text) {
        return new Promise((resolve, reject) => {
            if (!text || text.trim() === '') {
                return resolve();
            }

            // Convertimos el texto a Base64 para evitar el INFIERNO de las tildes, comillas y encodings en PowerShell
            const base64Text = Buffer.from(text, 'utf8').toString('base64');

            // Script de powershell básico invocando el Synth 
            const psScript = `
                $base64 = "${base64Text}"
                $bytes = [System.Convert]::FromBase64String($base64)
                $text = [System.Text.Encoding]::UTF8.GetString($bytes)
                
                Add-Type -AssemblyName System.speech
                $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
                $synth.Volume = 100 # Forzar volumen al máximo
                
                # Descomentar para ver las voces instaladas si falla
                # $synth.GetInstalledVoices() | Select-Object -ExpandProperty VoiceInfo | Format-Table Name
                
                $synth.Speak($text)
            `;

            console.log(`\n🔊 (JARVIS Hablando)...`);
            this.isSpeaking = true;

            this.currentProcess = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                psScript
            ]);

            this.currentProcess.stdout.on('data', (data) => {
                // console.log(`PS Output: ${data}`); // Útil para debugging
            });

            this.currentProcess.stderr.on('data', (data) => {
                console.error(`\n⚠️ Error interno de Voz en Windows: ${data}`);
            });

            this.currentProcess.on('close', (code) => {
                this.isSpeaking = false;
                this.currentProcess = null;
                resolve();
            });

            this.currentProcess.on('error', (err) => {
                this.isSpeaking = false;
                this.currentProcess = null;
                console.error("Error en TTS:", err);
                resolve(); // No rechazar para no tirar el bot entero por la voz
            });
        });
    }

    stop() {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.isSpeaking = false;
            this.currentProcess = null;
        }
    }
}

export default new TTSService();
