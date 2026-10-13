# Asistente de WhatsApp con IA: análisis y plan

*Análisis previo a cualquier desarrollo. Fecha: 13 de octubre de 2026.*

---

## 0. Resumen

**Recomendación:** no hace falta un CRM ni una plataforma de reservas. **Tu web ya tiene la base de datos que necesita el asistente** (Supabase: clientas, citas, solicitudes y lista de espera) y ya tienes un panel instalable en el iPhone y el Mac. Lo más económico y fiable es conectar WhatsApp a esa misma base de datos.

| Pieza | Opción recomendada | Coste aproximado |
|---|---|---|
| WhatsApp | Tu número actual de WhatsApp Business, conectado a la API oficial de Meta en **modo coexistencia** (sigues usando la app en el iPhone) a través de un proveedor barato | 9–12 €/mes del proveedor. Los mensajes que inicia la clienta son gratis |
| "Cerebro" del asistente | Una pequeña función en tu Supabase actual (Edge Function) | 0 € (plan gratuito) |
| IA | Claude (Anthropic), usada solo para entender texto libre y responder dudas | De menos de 1 € a unos 15 €/mes, según el modelo (ver §4) |
| Clientas | La tabla `clients` de tu web, más dos campos nuevos | 0 € |
| Agenda | El calendario de tu panel (tabla `appointments`), más una tabla de horario | 0 € |
| Avisos para ti | Pestaña "Pendientes" en tu panel y notificación push en el iPhone/Mac (Telegram o ntfy, gratis) | 0 € |
| **Total** | | **≈ 10–25 €/mes**, la mayor parte fija del proveedor de WhatsApp |

Los botones **sí son posibles** con la API oficial (no con la app normal de WhatsApp Business), con límites de texto que obligan a acortar dos de tus opciones (ver §5).

Tú no tendrás que programar. Yo escribo el código y te guío en los pasos que solo puedes hacer tú: crear cuentas, verificar el número y pegar claves.

---

## 1. Lo que ya tienes (revisado en tu web)

- **Supabase** (`rvqqhrxuyllvdvpuyncz.supabase.co`) con las tablas:
  - `clients`: nombre, teléfono y notas.
  - `appointments`: fecha, hora, nombre, teléfono, nota y categoría (`polvo`, `hibrida`, `pelo_a_pelo`, `neutralizacion`, `retoque`, `removedor`, `diseno`, `combo`, `otro`).
  - `requests`: solicitudes desde la web, con tipo, primera vez, franja, motivo y estado.
  - `waitlist`: lista de espera por franja.
- **Panel** (`/panel`), instalable como app en el iPhone y el Mac, con vista de mes, semana y día, colores por servicio y duraciones por servicio (polvo 90 min, híbrida y pelo a pelo 120 min, retoque 45, removedor 30…).
- **Formspree**, que te avisa por email de las solicitudes de la web.
- Botones "Contactar por WhatsApp" con enlaces `wa.me`. Abren un chat, pero no automatizan nada.

**Conclusión:** la "base de datos de clientas" y el "calendario de mi web" son la misma base de datos (Supabase), y está bien montada para esto. Conectar otro calendario o un CRM solo crearía dos fuentes de verdad y, con ellas, el riesgo de citas duplicadas.

Una advertencia que coincide con lo que pides: desde el cambio *"Guardar cliente automáticamente al llegar una solicitud"*, **en `clients` también entra gente que solo pidió información**. Por eso el asistente **no** debe considerar clienta antigua a alguien solo porque esté en `clients`. Debe mirar si tiene **una cita de micropigmentación ya realizada** o una marca explícita tuya (ver §6).

---

## 2. Cómo se conecta todo

```
 Clienta (WhatsApp)
        │  escribe
        ▼
 Meta · WhatsApp Cloud API  ◄── coexistencia ──►  Tu app WhatsApp Business (iPhone)
        │  webhook                                   (ves TODOS los chats y respondes tú)
        ▼
 Proveedor (solo reenvía; sin guardar mensajes)
        │
        ▼
 Supabase Edge Function "whatsapp-bot"   ◄──►  Claude (solo para texto libre)
        │  lee y escribe
        ▼
 Supabase: clients · appointments · requests · horario · conversaciones
        │
        ├──► Tu panel (iPhone / Mac): calendario + pestaña "Pendientes"
        └──► Notificación push a tu iPhone/Mac cuando hay un caso para ti
```

**Idea clave de diseño:** el **árbol de decisiones** (qué servicio, si es clienta tuya, cuándo derivar) lo controla **código fijo con botones**, no la IA. Así, los casos de micropigmentación antigua, de trabajos de otros centros y de removedor **siempre** pasan a ti, sin que la IA "improvise". La IA se usa para:

- entender mensajes escritos ("¿tienes algo el jueves por la tarde?", "quiero cambiar mi cita del día 20");
- responder dudas de información y precios **solo con tu texto oficial** (servicios, precios, cuidados);
- redactar respuestas cercanas.

Es más fiable, más barato (muchos pasos no llaman a la IA) y cumple la política de Meta. Desde enero de 2026, WhatsApp prohíbe los chatbots de IA "de propósito general", pero permite expresamente los asistentes de atención al cliente y reservas de un negocio.

---

## 3. Comparativa de opciones

### 3.1 WhatsApp: cómo automatizarlo

| Opción | Botones | Puedes seguir chateando desde tu iPhone | Coste | Valoración |
|---|---|---|---|---|
| **A. App WhatsApp Business sola** (bienvenida, ausencia, respuestas rápidas) | No | Sí | 0 € | No permite flujos, botones ni reservas. Insuficiente |
| **B. API oficial de Meta + número NUEVO** (directo, sin proveedor) | Sí | **No** en ese número: necesitarías una bandeja web para atender los casos derivados | 0 € fijos | Barato, pero rompe tu requisito de "hablar yo por WhatsApp" y cambia tu número |
| **C. API oficial + coexistencia con TU número actual** (mediante proveedor) | Sí | **Sí**: los chats se sincronizan con tu app | ≈ 9–12 €/mes (p. ej. Dualhook desde 12 $/mes, SendSeven desde 9 €/canal); 360dialog, unos 59 $/mes | **Recomendada** |
| **D. Plataformas de chatbot "todo en uno"** (WATI, Respond.io, Callbell, Kommo, ManyChat…) | Sí | Normalmente desde su bandeja, no desde la app | 30–100+ €/mes, más la IA aparte | Caras; integrar tu Supabase igualmente requiere conexiones a medida |
| **E. Soluciones no oficiales** (que emulan WhatsApp Web) | A veces | Sí | Baratas | **Desaconsejadas**: incumplen las normas de WhatsApp y hay riesgo real de bloqueo del número |

**Coexistencia: requisitos y limitaciones reales**

- El número debe estar ya en uso en la app **WhatsApp Business** (no en el WhatsApp normal), con algo de antigüedad. Algunos proveedores piden al menos 7 días de uso activo, y Meta puede denegarla en cuentas muy nuevas.
- Necesitas una cuenta de Meta Business (Business Manager). La empresa vinculada al número **no se puede cambiar después**, así que elígela con cuidado.
- Debes abrir la app del iPhone al menos cada ~2 semanas y **no desinstalarla**: se desconectaría.
- En ese número se desactivan algunas funciones de la app: mensajes temporales, fotos de "ver una vez", ubicación en tiempo real y listas de difusión. Los grupos no se sincronizan.
- Lo que respondas desde **WhatsApp Web o el Mac** puede no llegar al asistente como aviso de "ya ha respondido Noemi". Desde el iPhone sí llega. Por eso, además de detectarlo automáticamente, en el panel habrá un botón para pausar o reactivar el asistente en cada chat.
- Meta no permite hacer la coexistencia directamente con su consola si no eres "socio tecnológico". De ahí que haga falta un proveedor. Antes de contratarlo hay que comprobar que entrega los mensajes en directo a tu servidor (webhook) y que no cobra recargo por mensaje.

### 3.2 Precios de los mensajes de WhatsApp (Meta)

- Si la clienta te escribe, se abre una ventana de 24 h en la que **todas las respuestas son gratis**, botones incluidos.
- Los mensajes que tú inicias fuera de esa ventana (por ejemplo, un **recordatorio de cita** al día siguiente) usan una plantilla aprobada de tipo "utilidad". En España rondan los **2–3 céntimos** por mensaje (las cifras varían según la fuente; consúltalas en la tarifa oficial de Meta antes de activarlos). 100 recordatorios al mes son unos 2–3 €.
- Meta solo cambia precios al inicio de cada trimestre.

### 3.3 Agenda: Google Calendar, el calendario de tu web o una plataforma externa

| | **Calendario de tu web (Supabase)** | Google Calendar | Plataforma de reservas (Booksy, Fresha, Treatwell, Bewe…) |
|---|---|---|---|
| Coste | 0 € | 0 € | 0–80 €/mes, o comisión por clienta nueva |
| Ya tiene tus citas, categorías y duraciones | **Sí** | No | No |
| Evitar duplicados | **Sí, con una regla en la base de datos que impide solapes** (también si tú y el asistente reserváis a la vez) | Hay que sincronizar en los dos sentidos, que es justo donde nacen los duplicados | Sí, pero dentro de su sistema, y entonces tu panel queda desfasado |
| Tus reglas (retoque según meses, derivar casos) | Sí | Habría que programarlas igual | No admiten este triaje por WhatsApp |
| iPhone / Mac | Tu panel, instalado como app | App Calendario | Su app |

**Recomendación:** usar **tu propio calendario (Supabase)** como única fuente de verdad. Como extra opcional y gratuito, puedo publicar un **enlace de suscripción (.ics)** para que tus citas aparezcan, de solo lectura, en el Calendario del iPhone y del Mac, junto a tus citas personales.

Le falta una cosa: **definir tu disponibilidad**. Ahora el panel guarda citas, pero no sabe qué horas trabajas. Hay que añadir:

- **horario semanal** (por ejemplo, lunes a viernes de 10:00 a 14:00 y de 16:00 a 20:00);
- **bloqueos** (vacaciones, médico, días sueltos), que podrás crear desde el panel;
- margen entre citas (por ejemplo, 15 minutos para limpiar y preparar) y antelación mínima (por ejemplo, no reservar para dentro de menos de 24 h).

### 3.4 Clientas: ¿base de datos de la web o un CRM?

**Basta con tu base de datos actual.** Un CRM (HubSpot, Kommo, etc.) costaría dinero y duplicaría lo que ya tienes. Faltan tres cosas:

1. **Teléfonos normalizados** (`+34XXXXXXXXX`), porque WhatsApp entrega los números con prefijo (`34612345678`) y en tu tabla pueden estar como `612 34 56 78`. Añadiré un campo normalizado automático.
2. **Dos campos nuevos en la ficha:** "¿Se hizo la micro conmigo?" (Sí / No / Sin verificar) y "Fecha de la última micropigmentación". Sirven para tus clientas de antes del panel, que no tienen citas registradas.
3. **Contactos del iPhone:** la API de WhatsApp **no puede leer** los contactos de tu teléfono. Si quieres, puedes exportarlos desde iCloud (vCard) y los importo a `clients`, pero **solo como nombre**. Siguiendo tu regla, estar en contactos no convierte a nadie en clienta antigua.

### 3.5 La IA: qué modelo

| Modelo | Precio por millón de tokens (entrada / salida) | Coste estimado* |
|---|---|---|
| Claude Opus 5.5 (el más capaz) | 4 $ / 20 $ | ~7 céntimos por conversación → unos 14 $/mes con 200 conversaciones |
| Claude Haiku 5.5 (el más económico) | 0,10 $ / 0,50 $ | ~0,2 céntimos por conversación → menos de 1 $/mes |

\*Estimación propia, a validar en las pruebas: unas 8 llamadas a la IA por conversación y caché del texto fijo de instrucciones. Los pasos con botones no gastan IA.

Este asistente hace tareas acotadas: entender fechas, responder con tu texto de precios y clasificar la intención. **La decisión es tuya** (pregunta 1 de §11). Mi propuesta es probar con los dos durante la fase de pruebas y elegir viendo las respuestas reales. Se cambia de uno a otro en un minuto.

### 3.6 Avisos para ti

| Opción | Coste | En el iPhone | En el Mac |
|---|---|---|---|
| Pestaña **"Pendientes"** en tu panel (siempre) | 0 € | Sí | Sí |
| **Telegram** (un bot que solo te escribe a ti) | 0 € | Push instantáneo | App de Telegram |
| **ntfy** (app de notificaciones) | 0 € | Push | Web/app |
| Email (ya tienes Formspree) | 0 € (50 al mes en el plan gratuito) | Mail | Mail |
| Mensaje de WhatsApp a tu número **personal** | ~2–3 céntimos (plantilla) | Sí | Sí |

**Recomendación:** pestaña "Pendientes" + **Telegram**. Es gratis, inmediato y el aviso llevará el nombre, el motivo y un botón para abrir el chat de WhatsApp. Como con la coexistencia ves el chat y las fotos en tu app de WhatsApp Business, el aviso solo tiene que decirte "te toca a ti con X".

---

## 4. Coste mensual estimado (unas 200 conversaciones al mes)

| Concepto | Mínimo | Con más extras |
|---|---|---|
| Proveedor de coexistencia | ~9 € | ~12 € |
| Mensajes de clientas y respuestas | 0 € | 0 € |
| Recordatorios de cita (opcional, ~100) | 0 € | ~3 € |
| IA (Haiku 5.5 / Opus 5.5) | < 1 € | ~13 € |
| Supabase, avisos y panel | 0 € | 0 € |
| **Total** | **≈ 10 €/mes** | **≈ 28 €/mes** |

Supabase gratuito incluye 500.000 ejecuciones de funciones al mes, muy por encima de lo que necesitas. En el plan gratuito, un proyecto sin actividad durante una semana se pausa, pero los mensajes de WhatsApp y tu uso del panel lo mantienen activo.

---

## 5. Diseño de la conversación

WhatsApp permite **como máximo 3 botones por mensaje, de 20 caracteres cada uno**, o una **lista de hasta 10 opciones** (24 caracteres). Por eso:

- "Modificar o cancelar una cita" (29) → **"Cambiar o cancelar"** (18) ✅
- "Información y precios" (21) → **"Info y precios"** (14) ✅
- "Reservar una cita" (17) ✅ · "Micropigmentación" (17) ✅ · "Retoque" ✅ · "Removedor" ✅

### 5.1 Árbol

```
Bienvenida: «¡Hola! 😊 Bienvenida. ¿En qué puedo ayudarte?»
[Reservar una cita] [Cambiar o cancelar] [Info y precios]

RESERVAR → «¿Qué servicio te interesa?»  [Micropigmentación] [Retoque] [Removedor]

 ├─ MICROPIGMENTACIÓN
 │    «¿Tienes ahora micropigmentación o restos de pigmento en las cejas?»  [No, es mi 1ª vez] [Sí, tengo]
 │    ├─ 1ª vez → elegir técnica (lista: Efecto polvo · Híbrida · Pelo a pelo · Con neutralización · Combo amigas)
 │    │          → franja (Mañana / Tarde / Me da igual) → 3 huecos libres → confirmar → CITA ✅
 │    └─ Tiene pigmento → «Envíame fotos de tus cejas, mejor con la cámara trasera y buena luz,
 │                        de frente y sin maquillaje. Noemi las revisará y te escribirá personalmente.»
 │                        → DERIVAR A TI 🔔 (el asistente deja de responder en ese chat)
 │
 ├─ RETOQUE
 │    ¿Se puede verificar en tu base de datos (cita de micro realizada o ficha marcada)?
 │    ├─ Sí → «¡Hola, [nombre]! Veo que tu micro fue el [fecha].» → precio según meses:
 │    │        1–2 meses: 20 € · 3–12 meses: 45 € → huecos → CITA ✅
 │    │        12–24 meses o más → «Noemi tiene que valorarlo» → DERIVAR 🔔
 │    └─ No → «¿La micropigmentación te la hizo Noemi o fue en otro centro?»  [Me la hizo Noemi] [En otro centro]
 │         ├─ Otro centro → pedir fotos → DERIVAR 🔔 (sin precios ni citas de retoque)
 │         └─ "Me la hizo Noemi", pero no consta → ver pregunta 2 de §11
 │
 └─ REMOVEDOR → «Perfecto, Noemi te atenderá personalmente por aquí en cuanto pueda 😊» → DERIVAR 🔔

CAMBIAR O CANCELAR → busca sus próximas citas por su teléfono
   ├─ 0 citas → «No encuentro citas a este número» → DERIVAR 🔔
   └─ 1 o más → elegir cita → [Cambiar día/hora] [Cancelar cita]
        ├─ Cambiar → nuevos huecos → se mueve la MISMA cita (nunca se crea otra) ✅
        └─ Cancelar → confirmación → se anula → (opcional) aviso a la lista de espera de esa franja

INFO Y PRECIOS → la IA responde SOLO con tu texto oficial de servicios y precios, cuidados previos y posteriores,
                 dirección y horarios. Si no sabe algo → «Se lo pregunto a Noemi» → DERIVAR 🔔
```

**En cualquier momento:**

- Si la clienta escribe "hablar con Noemi" o similar → DERIVAR.
- Si envía fotos o audios sin que se le hayan pedido → DERIVAR.
- **Si tú respondes desde tu iPhone en ese chat**, el asistente se pausa automáticamente en esa conversación.
- Si alguien escribe a deshoras, el asistente puede reservar igualmente. Los casos derivados quedan para cuando tú puedas.

### 5.2 Al derivarte un caso

1. Se crea una entrada en `requests` con estado **"pendiente_valoracion"** y el motivo ("micro antigua", "otro centro", "removedor", "retoque +12 meses"…). Aparece en tu panel, que ya tiene esta pestaña.
2. Te llega el push: *"🔔 Laura (+34 6xx…): micro antigua, ha enviado 3 fotos. [Abrir WhatsApp]"*.
3. El asistente **se calla** en ese chat hasta que pulses "Devolver al asistente" en el panel, o hasta pasados X días sin actividad (lo decides tú).

---

## 6. Cómo reconocerá a tus clientas

Cuando llega un mensaje, se normaliza el número y se consulta, por este orden:

1. **¿Tiene una cita de micropigmentación ya pasada** en `appointments` (categorías polvo, híbrida, pelo a pelo, neutralización o combo)? → **clienta verificada**. Se toma la fecha de la última para calcular el retoque.
2. **¿Su ficha está marcada por ti** como "micro conmigo = Sí", con fecha? → **verificada**.
3. **¿Está en `clients` pero sin nada de lo anterior?** → se usa su nombre para saludar, pero **se considera no verificada** y se le pregunta.
4. **No consta** → nueva.

Nunca se le dirá a nadie "no te encuentro en mi base de datos". Se pregunta con naturalidad.

Para que funcione con tus clientas de antes del panel, conviene que marques en sus fichas "micro conmigo" y la fecha aproximada. Puede ser poco a poco: mientras no estén marcadas, el asistente simplemente pregunta.

---

## 7. Reservas sin duplicados

- **Regla en la base de datos** que impide guardar dos citas que se solapen, teniendo en cuenta la duración de cada servicio y el margen. Funciona aunque tú añadas una cita en el panel en el mismo segundo en que el asistente reserva.
- Al ofrecer huecos se calcula: horario − bloqueos − citas existentes (con duración y margen) − antelación mínima.
- Al confirmar, el hueco se vuelve a comprobar. Si alguien lo ha ocupado entretanto, se ofrecen otros.
- Al cambiar una cita se **modifica la misma fila**, nunca se crea una nueva.
- Las citas del asistente llevan la etiqueta "WhatsApp" en la nota, para que en el panel sepas su origen.
- Zona horaria: Europa/Madrid.

---

## 8. Limitaciones y riesgos, sin adornos

- **Aprobación de Meta:** verificar el negocio y activar la coexistencia puede tardar desde horas hasta varios días, y depende de Meta, no de nosotros.
- **La IA puede equivocarse al entender un texto.** Por eso las decisiones importantes van con botones, las reservas siempre piden una confirmación final ("¿Confirmo el martes 21 a las 10:00 para efecto polvo?") y los precios salen de tu texto, nunca inventados.
- **Si respondes desde WhatsApp Web o el Mac**, quizá el asistente no detecte que ya has entrado. Usa el botón "Pausar asistente" del panel, o responde desde el iPhone.
- **Fotos:** el asistente no las analiza ni da valoraciones. Solo las pide y te avisa. Tú las ves directamente en tu app.
- **Protección de datos (RGPD):** las fotos y los datos de salud estética son sensibles. Añadiré un aviso breve en el primer mensaje y un enlace a tu política de privacidad, y los mensajes no se guardarán más tiempo del necesario. Conviene revisar tu política de privacidad para mencionar WhatsApp y el asistente.
- **Proveedor de coexistencia:** es una pieza externa. Si sube precios o cierra, se puede cambiar a otro sin tocar tu base de datos ni el asistente; solo cambia la "tubería".

---

## 9. Plan paso a paso

Leyenda: 👩 lo haces tú (te guiaré click a click) · 🤖 lo hago yo (código, sin que tengas que tocarlo).

### Fase 0: decisiones (hoy)
- 👩 Responder las preguntas de §11.

### Fase 1: preparar la base de datos y el panel (sin tocar WhatsApp todavía)
- 🤖 Añadir a Supabase: horario semanal, bloqueos, teléfono normalizado, campos "micro conmigo" y "fecha última micro", tabla de conversaciones, la regla anti-solapes y el estado "pendiente_valoracion".
- 🤖 Panel: pantalla de **Horario y bloqueos**, pestaña **Pendientes** con "Devolver al asistente" y "Pausar asistente", y los campos nuevos en la ficha de clienta.
- 👩 Pegar en Supabase (SQL Editor) el script que te dé y comprobar en el panel que todo se ve bien.
- 👩 Rellenar tu horario y marcar en las fichas de tus clientas habituales "micro conmigo" + fecha.

### Fase 2: cuentas
- 👩 Comprobar que tu número usa **WhatsApp Business** (no el WhatsApp normal) y que la app está actualizada.
- 👩 Crear o confirmar tu **cuenta de Meta Business** (business.facebook.com) con los datos reales del negocio.
- 👩 Crear la cuenta en el **proveedor de coexistencia** elegido (prueba gratis de 14 días) y conectar tu número escaneando el código QR desde la app de WhatsApp Business.
- 👩 Crear una **clave de API de Claude** en console.anthropic.com y poner un límite de gasto mensual (por ejemplo, 20 $) para estar tranquila.
- 👩 Crear el bot de **Telegram** para tus avisos (2 minutos con @BotFather).

### Fase 3: el asistente
- 🤖 Programar la función `whatsapp-bot` en Supabase: recepción de mensajes, árbol de botones, lógica de clientas, huecos, reservas y cambios, derivación y avisos.
- 🤖 Escribir el "texto oficial" de servicios, precios y cuidados a partir de tu web, para que lo revises.
- 👩 Pegar en Supabase las claves secretas (WhatsApp, Claude, Telegram). Te diré exactamente dónde. **Nunca** irán en la web pública.
- 👩 Pegar en el proveedor la dirección del webhook que te daré.

### Fase 4: pruebas, sin clientas reales
- Un "modo prueba" en el que el asistente **solo contesta a los números que tú indiques** (el tuyo, el de una amiga…). El resto de chats siguen como ahora, atendidos por ti.
- 👩 Probar todos los caminos: primera vez, micro antigua, retoque mío, retoque de otro centro, removedor, cambiar, cancelar, preguntar precios y escribir cosas raras.
- 🤖 Ajustar los textos y la lógica según lo que veas.

### Fase 5: puesta en marcha
- Activar para todo el mundo.
- Primera semana: revisar a diario la pestaña Pendientes y las citas creadas.

### Fase 6: extras opcionales (cuando todo vaya bien)
- Recordatorio automático el día antes, con botones "Confirmo" y "Necesito cambiarla" (~2–3 céntimos cada uno).
- Aviso automático a la lista de espera cuando se libera un hueco.
- Suscripción .ics para ver las citas en el Calendario del iPhone y del Mac.
- Mensaje de seguimiento para recordar el retoque a las 4–6 semanas de una micro.

---

## 10. Qué NO hace falta pagar

- ❌ CRM: tu Supabase ya cumple esa función.
- ❌ Plataforma de reservas: duplicaría tu calendario.
- ❌ Zapier, Make o n8n de pago: la lógica vive en tu Supabase gratis.
- ❌ Plataformas de chatbot de 50–100 €/mes.
- ❌ Plan de pago de Supabase.
- ❌ Insignia verde ni "Meta Verified".

---

## 11. Preguntas que necesito que me respondas

1. **Modelo de IA:** ¿Claude Haiku 5.5 (menos de 1 €/mes) u Opus 5.5 (unos 14 €/mes, más capaz)? ¿O prefieres probar los dos en la fase 4?
2. **Retoque, cuando la clienta dice "me la hiciste tú" pero no consta en la base de datos:**
   (a) derivártelo siempre, o
   (b) preguntarle cuándo se la hizo, darle cita con el precio que corresponda y marcarla como **"por verificar"** con aviso para ti.
   *Mi recomendación: (b), porque así el asistente resuelve más casos sin que nada se te escape.*
3. **Horario:** días y horas en que atiendes, margen entre citas y antelación mínima para reservar o cancelar.
4. **Política de cancelación:** ¿pueden cancelar o cambiar por WhatsApp hasta cuántas horas antes? ¿Pides señal o depósito? (El cobro de señales sería otra fase.)
5. **¿El retoque de 1–2 meses es solo para clientas tuyas?** (Entiendo que sí, como todo retoque.) ¿Y el diseño de cejas con henna también se puede reservar por WhatsApp?
6. **Combo amigas:** ¿hace falta el nombre y el teléfono de la amiga? ¿Se reservan dos citas seguidas o en paralelo?
7. **Avisos:** ¿Telegram, ntfy, email o WhatsApp a tu número personal?
8. **Tu número:** ¿ya usas la app **WhatsApp Business** con el número del negocio, y desde cuándo, aproximadamente?
9. **Si escriben a deshoras:** ¿el asistente reserva igualmente 24/7? (Recomendado.)
10. **¿Quieres importar los contactos del iPhone** a la base de datos (solo nombres)?

---

## Fuentes consultadas

- Meta: precios de la WhatsApp Business Platform: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Meta: botones interactivos (máx. 3, 20 caracteres): https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- Meta: incorporación de usuarios de la app WhatsApp Business (coexistencia): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- 360dialog: requisitos y limitaciones de la coexistencia: https://docs.360dialog.com/docs/hub/embedded-signup/whatsapp-coexistence
- Seven.io: modo coexistencia: https://help.seven.io/en/whatsapp/whatsapp-coexistence
- Dualhook: precios: https://dualhook.com/pricing · comparativa de proveedores: https://dualhook.com/best-whatsapp-coexistence-providers
- SendSeven: guía de coexistencia 2026: https://sendseven.com/en/blog/whatsapp-coexistence-guide-2026
- Respond.io: política de chatbots de IA en WhatsApp 2026: https://respond.io/blog/whatsapp-chatbot-policy-2026
- Supabase: límites del plan gratuito (resumen de terceros, a confirmar en supabase.com/pricing): https://automationatlas.io/answers/supabase-free-tier-limits-2026/
- Anthropic: precios de los modelos Claude (documentación oficial de la API).

*Las cifras de proveedores y de Meta cambian. Confirmaré los precios exactos el día que contratemos cada servicio.*
