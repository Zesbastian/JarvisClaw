# SecureClaw - Evolución de Arquitectura y Resolución de Problemas (Marzo 2026)

## Contexto del Proyecto
SecureClaw nació como un prototipo de *"Secure-by-Design LLM Engine"* en Node.js, actuando como un puente entre la API de Gemini (el Cerebro) y el sistema operativo local (las Manos), pasando obligatoriamente por una "Conciencia" (reglas hardcodeadas) y una "Aduana" (Human in the Loop).

El objetivo último del usuario es evolucionar este prototipo hacia un verdadero **"Agente JARVIS"** completo (Voz, asincronía, control de SO). Sin embargo, hoy nos centramos en estabilizar y optimizar el núcleo lógico (el "Cerebro") para hacerlo viable financieramente y técnicamente.

---

## Retos Superados: La Crisis de Cuotas API y SDKs

### 1. El Bloqueo de Quotas (Error 429) y Modelos
*   **Problema:** Inicialmente, probamos modelos experimentales y modelos antiguos (`gemini-1.5-flash`, `gemini-2.0-flash-lite`, etc.). Rápidamente chocamos contra el error **`429 Quota Exceeded`** con apenas unas preguntas.
*   **Investigación:** Analizamos la documentación oficial de Google Cloud y AI Studio. Descubrimos que:
    *   Las claves API de proyectos nuevos ("Gratis") tienen límites de RPM (Requests Per Minute) bajísimos en modelos experimentales.
    *   Algunos modelos, como `gemini-2.0-flash-lite`, mostraron un error `404 Not Found` de deprecación para cuentas nuevas.
*   **Solución:** Estabilizamos la base mudándonos definitivamente al modelo **`gemini-2.5-flash`** que ofrece el balance perfecto de velocidad, disponibilidad en el *Free Tier* de AI Studio, y un gran context window (1 Millón de tokens).

### 2. El Caos de los SDK de Google
*   **Problema:** Hubo múltiples crashes debidos a incompatibilidades entre el viejo SDK (`@google/generative-ai` v1beta) y la sintaxis esperada por la API más actual. Hubo errores como *`ContentUnion is required`* y problemas al devolver resultados de uso de herramientas (Function Calling).
*   **Solución:** Estandarizamos el código al **SDK de próxima generación (`@google/genai`)**. 
    *   Actualizamos la firma de `this.chatSession.sendMessage({ message: texto })`.
    *   Corregimos la forma de leer respuestas (`response.text` directo).
    *   Inyectamos los resultados de las herramientas (`save_memory`, `read_file`) como texto normal en el historial en lugar de objetos JSON complejos, que los SDK iterativos de Google a menudo fallaban en parsear.

---

## Fase 4: Optimización de Costos y Arquitectura Local (RAG)

Una vez que el usuario asignó una cuenta de facturación ("Pay-as-you-go") para tener cuotas ilimitadas, surgió un nuevo problema: **Evitar la bancarrota por fugas de tokens.**

### El Problema de la "Inflación de Tokens"
El bot enviaba miles de tokens basura a la API paga en cada mensaje:
1.  Todo el archivo local de memorias (`.engram.json`) se adjuntaba al inicio de cada conversación.
2.  El historial de chat crecía infinitamente, reenviando la discusión de la primera hora a Google en el minuto 60.
3.  La herramienta `read_file` mandaba el contenido completo de archivos (ej. 1000 líneas) al SDK.

### La Solución Implementada:
Diseñamos e integramos la **"Fase 4: Cost Optimization"**:

1.  **RAG Local de $0 Dólares (`memory.js`):** 
    En lugar de inyectar todo, instalamos `string-similarity`. Ahora, el sistema toma lo que pregunta el humano, compara matemáticamente con todas las memorias guardadas localmente, y extrae solo el **Top 3 de contextos relevantes** para inyectarle a Gemini. Esto ahorra inmensamente el uso de tokens de Input en cuentas de pago.
2.  **Ventana Deslizante (Sliding Window History):**
    En `index.js`, podamos forzosamente `chatSession.history`. El agente ahora solo "recuerda" los últimos 10 mensajes. Los anteriores no se mandan a Google, manteniendo un tope plano de costos de API.
3.  **Paginación de Herramientas (`read_file` truncada):**
    Se incluyeron parámetros obligatorios opcionales `start_line` y `end_line` en la declaración de herramientas que van a la IA. Si el IA olvida usarlos y lee un archivo gigante, el script de Node detiene la lectura a las 100 líneas por seguridad y le dice al bot que use paginación para ver más.

---

> **Conclusión del Día:** 
> Se finalizó la estabilización estructural y financiera del prototipo base. El motor conversacional base (Orquestador-Aduana-Conciencia-Herramientas base) opera sin gastar de más y sorteando las limitaciones de la API v1beta de Gemini.
> 
> *Próximos pasos planteados:* Avanzar hacia capacidades "JARVIS" (Voz, Visión, Automatización proactiva de OS/IoT).
