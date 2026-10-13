# Guía paso a paso: asistente de WhatsApp

Sigue los pasos en orden. Cuando termines cada uno, avísame. Si algo no coincide con lo que ves en pantalla, hazme una captura y te digo por dónde seguir.

**Ya hecho por mí (no tienes que tocarlo):**
- `supabase/01_asistente_whatsapp.sql`: prepara la base de datos (tus franjas, días bloqueados, fichas y conversaciones).
- `supabase/functions/whatsapp-bot/index.ts`: el asistente.
- **Backstage de tu web** (y también el panel aparte): nueva pestaña **WhatsApp** (chats que atiendes tú, días bloqueados y horario) y, en cada ficha de clienta, el campo **"Micropigmentación hecha por ti"** con la fecha.

Todo está probado con conversaciones simuladas: reservar, retoque de clienta tuya, otro centro, removedor, cambiar, cancelar, doble reserva del mismo hueco, avisos y silencio cuando respondes tú.

---

## Paso 1. Preparar la base de datos (5 minutos)

1. Entra en **supabase.com** → tu proyecto.
2. Menú izquierdo → **SQL Editor** → **New query**.
3. Abre el archivo `supabase/01_asistente_whatsapp.sql`, copia **todo** el contenido, pégalo y pulsa **Run**.
4. Debe salir **"Success. No rows returned"**.
5. **Seguridad (importante):** menú izquierdo → **Authentication** → **Sign In / Providers** (o *Settings*) → desactiva **"Allow new users to sign up"**. Así nadie más puede crearse una cuenta y entrar en tu panel.
6. Entra en el backstage de tu web ("Acceso profesional", abajo del todo) y comprueba que aparece la pestaña **WhatsApp** con tu horario.

## Paso 2. Completar datos (cuando puedas, poco a poco)

- **Fichas de clientas:** en Clientes → Ver ficha → "Micropigmentación hecha por ti": pon **Sí** y la **fecha de la última micro** a tus clientas de antes del panel. Las que tengan una cita de micro en tu calendario ya se reconocen solas.
- **Dirección y textos:** en Supabase → **Table Editor** → tabla **bot_ajustes**:
  - `direccion`: la dirección del estudio (se envía al confirmar la cita).
  - `info_extra`: lo que quieras que el asistente sepa para responder dudas (cuidados antes y después, formas de pago…).
  - `antelacion_horas` (12): horas mínimas para reservar, cambiar o cancelar por WhatsApp.
  - `dias_vista` (45): hasta cuántos días en adelante se ofrecen huecos.
  - `dias_reactivar` (7): si un chat que atendiste tú lleva estos días sin mensajes, el asistente vuelve a atenderlo.
- **Vacaciones y festivos:** backstage → pestaña WhatsApp → "Días sin citas".

## Paso 3. Cuenta de Meta Business (15 minutos)

1. Entra en **business.facebook.com** con tu Facebook o Instagram.
2. Si no tienes "portfolio empresarial", créalo con los **datos reales** del negocio (nombre, email y web). La empresa vinculada al número **no se puede cambiar después**.
3. Actualiza la app **WhatsApp Business** del iPhone desde la App Store.

## Paso 4. Conectar tu número con la API: coexistencia (20 minutos más la espera de Meta)

Hace falta un proveedor autorizado por Meta. Propuesta: **Dualhook** (desde 12 $/mes, 14 días de prueba gratis), que envía los mensajes directamente a tu asistente sin guardarlos.

1. Crea la cuenta en el proveedor y empieza la prueba gratuita.
2. Elige **conectar un número existente de la app WhatsApp Business** (*coexistence* / *existing WhatsApp Business App*).
3. Inicia sesión con Facebook, elige el portfolio del paso 3 e introduce el número **644 924 469**.
4. Confirma desde la app de WhatsApp Business en el iPhone, con el código o el QR que te muestre. Si te pregunta por compartir el historial de chats, puedes aceptar.
5. **Antes de pagar nada**, comprueba que en el panel del proveedor aparecen estas tres cosas y apúntalas:
   - **Phone Number ID** (un número largo),
   - **Access token** (una clave larga),
   - un sitio para poner la **URL del webhook** (*webhook URL / callback URL*).

   Si falta alguna, avísame: la alternativa probada es **360dialog** (más cara), y el asistente ya está preparado para funcionar con ella.

> Después de conectar, sigue usando la app de WhatsApp Business con normalidad. Ábrela al menos una vez cada dos semanas y no la desinstales.

## Paso 5. Plantilla de aviso para tu WhatsApp personal (5 minutos, Meta la aprueba en horas)

En **business.facebook.com** → **WhatsApp Manager** → **Plantillas de mensajes** → **Crear plantilla** (o desde el panel del proveedor):

- **Categoría:** Utilidad
- **Nombre:** `aviso_chat_pendiente`
- **Idioma:** Español
- **Cuerpo:**
  ```
  Tienes un chat de WhatsApp pendiente de responder.
  Clienta: {{1}}
  Teléfono: {{2}}
  Motivo: {{3}}
  ```
  Ejemplos que pide Meta: `Laura García` · `+34600000000` · `Removedor`
- **Botón:** respuesta rápida → `Visto`

Truco para ahorrar: cuando te llegue un aviso, pulsa **Visto**. Durante las 24 h siguientes los avisos son gratis.

## Paso 6. Clave de la IA (5 minutos)

1. Entra en **console.anthropic.com** y crea la cuenta.
2. **Billing:** añade 5 $ de saldo. Con el modelo elegido, debería durar muchos meses.
3. **Limits:** pon un límite de gasto mensual, por ejemplo 5 $.
4. **API Keys** → **Create key** → nombre "whatsapp". Copia la clave (empieza por `sk-ant-`); solo se ve una vez.

## Paso 7. Publicar el asistente en Supabase (10 minutos)

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nombre: `whatsapp-bot`.
3. Borra el ejemplo, pega **todo** el contenido de `supabase/functions/whatsapp-bot/index.ts` y pulsa **Deploy**.
4. En los ajustes de la función (**Details / Settings**), **desactiva "Enforce JWT verification"** (o "Verify JWT"). Si no, WhatsApp no podrá entregarle los mensajes.
5. **Edge Functions** → **Secrets** → añade una a una:

| Nombre | Valor |
|---|---|
| `WA_TOKEN` | el Access token del paso 4 |
| `WA_PHONE_NUMBER_ID` | el Phone Number ID del paso 4 |
| `WEBHOOK_KEY` | una contraseña inventada, larga, solo letras y números (p. ej. `cejas7Kx92mQpL4`) |
| `WA_VERIFY_TOKEN` | otra palabra inventada (por si el proveedor la pide) |
| `ANTHROPIC_API_KEY` | la clave del paso 6 |
| `NOEMI_WHATSAPP` | `34644737315` |
| `MODO_PRUEBA` | `34644737315` (el asistente solo responderá a tu número personal mientras probamos) |

## Paso 8. Conectar WhatsApp con el asistente (5 minutos)

En el panel del proveedor, en "Webhook URL", pon (cambiando el final por tu `WEBHOOK_KEY`):

```
https://rvqqhrxuyllvdvpuyncz.supabase.co/functions/v1/whatsapp-bot?key=TU_WEBHOOK_KEY
```

- Si pide "Verify token", pon tu `WA_VERIFY_TOKEN`.
- Si deja elegir eventos, marca **messages** y **smb_message_echoes**. Este último sirve para que el asistente se calle cuando respondes tú desde el móvil.

## Paso 9. Probar (modo prueba)

Desde tu WhatsApp personal, escribe al número del negocio y prueba todos los caminos:

- [ ] Saludo → botones
- [ ] Reservar → Micropigmentación → primera vez → técnica → hueco → nombre → confirmar. Mira que la cita aparece en el panel.
- [ ] Micropigmentación → "Sí, tengo" → pide fotos y te llega el aviso
- [ ] Retoque (tu número no es clienta) → otro centro → fotos y aviso
- [ ] Removedor → aviso
- [ ] Cambiar o cancelar → mover la cita de prueba → cancelarla
- [ ] Info y precios → escribe una pregunta ("¿cuánto dura el efecto polvo?")
- [ ] Escribe "quiero hablar con Noemi"
- [ ] Responde tú desde la app del negocio en un chat derivado → el asistente no vuelve a hablar en ese chat
- [ ] En el backstage → pestaña WhatsApp → "Devolver al asistente"

Mientras dure la prueba, las clientas reales siguen como siempre: el asistente no les contesta.

## Paso 10. Activarlo para todas

Cuando todo vaya bien: Supabase → Edge Functions → Secrets → **borra `MODO_PRUEBA`**. Desde ese momento, el asistente atiende a todo el mundo.

Primera semana: revisa cada día la pestaña **WhatsApp** y las citas nuevas (llevan la nota "WhatsApp").

---

## Cuánto va a costar al mes

- Proveedor de coexistencia: unos 12 $.
- IA (Claude Haiku 5.5): céntimos.
- Avisos a tu WhatsApp: 0 € si pulsas "Visto"; si no, unos 2–3 céntimos cada uno.
- Mensajes con clientas: 0 €.
- Supabase: 0 €.

## Pendiente de tu respuesta

1. **El SMS que se envía al reservar:** ¿qué servicio lo manda (nombre de la web o app)? Necesito comprobar que también se envía cuando la cita la crea el asistente. Las citas del asistente se guardan en la misma tabla de citas, con el teléfono en formato `+34XXXXXXXXX`.
2. **Dirección del estudio:** ¿quieres que el asistente la mande al confirmar? Si es que sí, ponla en `bot_ajustes` (paso 2).
