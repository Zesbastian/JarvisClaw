import pyaudio
import wave
import sys
import argparse

def record_audio(filename="temp_audio.wav", max_seconds=30):
    CHUNK = 1024
    FORMAT = pyaudio.paInt16
    CHANNELS = 1
    RATE = 16000 # 16kHz es el estándar recomendado para STT

    p = pyaudio.PyAudio()

    try:
        stream = p.open(format=FORMAT,
                        channels=CHANNELS,
                        rate=RATE,
                        input=True,
                        frames_per_buffer=CHUNK)

        print("🎙️ (JARVIS): Escuchando... (Max 30s. Presiona Ctrl+C en consola si termina antes)")

        frames = []
        for i in range(0, int(RATE / CHUNK * max_seconds)):
            data = stream.read(CHUNK, exception_on_overflow=False)
            frames.append(data)
            
    except KeyboardInterrupt:
        # PTT o corte normal manual
        pass
    except Exception as e:
        print(f"Error grabando: {e}")
        sys.exit(1)
    finally:
        print("⏸️ Grabación finalizada.")
        
        if 'stream' in locals() and stream.is_active():
            stream.stop_stream()
            stream.close()
        p.terminate()

        # Guardar archivo
        wf = wave.open(filename, 'wb')
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(p.get_sample_size(FORMAT))
        wf.setframerate(RATE)
        wf.writeframes(b''.join(frames))
        wf.close()
        
        print(f"[{filename}] guardado.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="temp_audio.wav", help="Ruta del archivo de salida")
    parser.add_argument("--sec", type=int, default=30, help="Segundos máximos a grabar")
    args = parser.parse_args()
    
    record_audio(args.out, args.sec)
