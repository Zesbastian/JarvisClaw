import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

async function testQuota() {
    console.log("Testeando cuota de Gemini API...");
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const result = await model.generateContent("Hola, esto es una prueba de cuota corta. Responde 'OK'.");
        console.log("Respuesta Exitosa:", result.response.text());
    } catch (e) {
        console.error("ERROR REAL DETECTADO:");
        console.error("Código de Estado HTTP:", e.status);
        console.error("Mensaje:", e.message);
        console.dir(e, { depth: null });
    }
}

testQuota();
