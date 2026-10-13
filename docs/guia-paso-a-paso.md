# Guía paso a paso: asistente de WhatsApp

> **Importante:** el asistente va conectado a tu web de **Gestión** (webnoemi.netlify.app/gestion) y a su base de datos. No toca la web antigua de este repositorio.

Sigue los pasos en orden. Cuando termines cada uno, avísame. Si algo no coincide con lo que ves en pantalla, hazme una captura.

## Cómo funciona con tu Gestión

El asistente **no tiene agenda propia**. Usa exactamente lo mismo que tu página de reservas (`/reservas/`):

- **Huecos:** los de *Gestión → Reservas online*. Tus franjas de lunes, miércoles y sábado se configuran ahí, como ya haces.
- **Servicios y precios:** los de *Gestión → Servicios y precios* que estén marcados como reservables online.
- **Señal:** igual que en la web. La clienta recibe el enlace para pagar con tarjeta o las instrucciones del Bizum, y tiene 15 minutos. Si no paga, el hueco se libera solo.
- **Retoques:** solo se reservan directamente si la clienta tiene una micropigmentación **cobrada** en tu Gestión. Si no, se te pasa a ti.
- **Cambios y cancelaciones:** con las mismas reglas y el mismo plazo de cancelación que la web. Quedan en el historial de la cita. Las citas que pusiste tú a mano te las pasa a ti.
- **Una sola reserva activa por clienta**, como en la web.
- **Agenda online cerrada:** el asistente no reserva y te pasa el chat.

## Lo que ya está hecho (no tienes que tocarlo)

- `asistente-whatsapp/01_base_de_datos.sql`: añade a tu base de datos de Gestión lo que necesita el asistente, sin tocar nada de lo que ya tienes.
- `asistente-whatsapp/whatsapp-bot/index.ts`: el asistente.
- `asistente-whatsapp/gestion/`: el apartado nuevo **💬 WhatsApp** del menú de Gestión. Muestra los chats que atiendes tú, con «Abrir chat» y «Devolver al asistente», y los ajustes del asistente (dirección del estudio e información extra).

Todo está probado con una copia de tu base de datos de Gestión (tu mismo esquema) y con tu app de Gestión en el navegador:
- reservar primera vez y retoque;
- clienta ya con cita activa;
- otro centro;
- cambiar y cancelar;
- cita puesta a mano;
- avisos a tu WhatsApp personal.

---

## Paso 1. Preparar la base de datos de Gestión (5 minutos)

1. Entra en **supabase.com** y abre el proyecto de tu Gestión. Es el que tiene la dirección `rxvdluocgnymaytczwid`.
2. **SQL Editor** → **New query** → pega **todo** `asistente-whatsapp/01_base_de_datos.sql` → **Run**.
3. Debe salir **"Success. No rows returned"**.

## Paso 2. Añadir el apartado WhatsApp a tu Gestión

Hay que subir 3 archivos a tu web de Netlify, dentro de la carpeta `gestion/`:

| Archivo | Qué cambia |
|---|---|
| `gestion/index.html` | una línea nueva en el menú: «💬 WhatsApp» |
| `gestion/js/router.js` | una línea nueva para abrir el apartado |
| `gestion/js/views/whatsapp.js` | archivo nuevo: el apartado en sí |

👉 **Necesito saber cómo publicas tu web en Netlify** (ver «Pendiente de tu respuesta» al final). Según cómo sea, lo subo yo o te digo exactamente qué arrastrar.

## Paso 3. Cuenta de Meta Business (15 minutos)

1. Entra en **business.facebook.com** con tu Facebook o Instagram.
2. Si no tienes portfolio empresarial, créalo con los **datos reales** del negocio. La empresa vinculada al número **no se puede cambiar después**.
3. Actualiza la app **WhatsApp Business** del iPhone.

## Paso 4. Conectar tu número 644 924 469 con la API: coexistencia

Propuesta: **Dualhook** (desde 12 $/mes, 14 días de prueba gratis).

1. Crea la cuenta y empieza la prueba.
2. Elige conectar un **número existente de la app WhatsApp Business** (*coexistence*).
3. Inicia sesión con Facebook, elige el portfolio del paso 3 e introduce el **644 924 469**.
4. Confirma desde la app de WhatsApp Business con el código o el QR que te muestre.
5. **Antes de pagar**, comprueba que el panel del proveedor te da estas tres cosas y apúntalas:
   - **Phone Number ID**
   - **Access token**
   - un sitio para poner la **URL del webhook**

   Si falta algo, avísame. La alternativa es 360dialog.

> Sigue usando la app de WhatsApp Business con normalidad. Ábrela al menos cada dos semanas y no la desinstales.

## Paso 5. Plantilla de aviso para tu WhatsApp personal

En **WhatsApp Manager** → **Plantillas de mensajes** → **Crear plantilla**:
- **Categoría:** Utilidad · **Nombre:** `aviso_chat_pendiente` · **Idioma:** Español
- **Cuerpo:**
  ```
  Tienes un chat de WhatsApp pendiente de responder.
  Clienta: {{1}}
  Teléfono: {{2}}
  Motivo: {{3}}
  ```
  Ejemplos que pide Meta: `Laura García` · `+34600000000` · `Removedor`
- **Botón:** respuesta rápida `Visto`

Cuando te llegue un aviso, pulsa **Visto**. Los avisos de las 24 h siguientes son gratis.

## Paso 6. Clave de la IA (5 minutos)

**console.anthropic.com**:
1. Crea la cuenta.
2. **Billing:** añade 5 $ de saldo.
3. **Limits:** pon un límite mensual de 5 $.
4. **API Keys** → **Create key**. Copia la clave (empieza por `sk-ant-`).

## Paso 7. Publicar el asistente (10 minutos), en el proyecto de Gestión

1. Supabase (proyecto de Gestión) → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nombre: `whatsapp-bot`. Pega **todo** `asistente-whatsapp/whatsapp-bot/index.ts` → **Deploy**.
3. En los ajustes de la función, **desactiva "Enforce JWT verification"**.
4. **Edge Functions → Secrets**, añade:

| Nombre | Valor |
|---|---|
| `WA_TOKEN` | Access token del paso 4 |
| `WA_PHONE_NUMBER_ID` | Phone Number ID del paso 4 |
| `WEBHOOK_KEY` | una contraseña inventada, larga, solo letras y números |
| `WA_VERIFY_TOKEN` | otra palabra inventada (por si el proveedor la pide) |
| `ANTHROPIC_API_KEY` | la clave del paso 6 |
| `NOEMI_WHATSAPP` | `34644737315` |
| `MODO_PRUEBA` | `34644737315` (solo te responde a ti mientras probamos) |

## Paso 8. Conectar WhatsApp con el asistente

En el proveedor, como "Webhook URL" (cambia el final por tu `WEBHOOK_KEY`):
```
https://rxvdluocgnymaytczwid.supabase.co/functions/v1/whatsapp-bot?key=TU_WEBHOOK_KEY
```
- Si pide "Verify token", pon tu `WA_VERIFY_TOKEN`.
- Si deja elegir eventos, marca **messages** y **smb_message_echoes**.

## Paso 9. Probar desde tu WhatsApp personal

Comprueba que la **agenda online está abierta** en Reservas online y prueba:

- [ ] Saludo → botones
- [ ] Reservar → Micropigmentación → primera vez → técnica → hueco → nombre → confirmar. Te llega el enlace de pago y la cita sale en Reservas online.
- [ ] Micropigmentación → "Sí, tengo" → pide fotos y te llega el aviso
- [ ] Retoque → otro centro → fotos y aviso
- [ ] Removedor → aviso
- [ ] Cambiar o cancelar la cita de prueba
- [ ] Info y precios → escribe una pregunta
- [ ] Escribe "quiero hablar con Noemi"
- [ ] Responde tú desde la app del negocio en un chat derivado → el asistente se calla
- [ ] Gestión → 💬 WhatsApp → "Devolver al asistente"

Las clientas reales no notan nada mientras dure la prueba.

## Paso 10. Activarlo para todas

Supabase → Edge Functions → Secrets → **borra `MODO_PRUEBA`**.

---

## Coste al mes
- Proveedor: unos 12 $.
- IA (Claude Haiku 5.5): céntimos.
- Avisos a tu WhatsApp: 0 € si pulsas «Visto»; si no, 2–3 céntimos cada uno.
- Mensajes con clientas y Supabase: 0 €.

## Pendiente de tu respuesta

1. **¿Cómo publicas webnoemi.netlify.app?**
   - (a) Netlify está conectado a un repositorio de GitHub. ¿Cuál? No es `web-cejas` ni `web`.
   - (b) Arrastras la carpeta en netlify.com.
   - (c) No lo sabes. Entonces mándame una captura de netlify.com → tu sitio → *Site configuration* → *Build & deploy*.
2. **El SMS al reservar:** ¿qué servicio lo envía? Así compruebo que también salga con las reservas por WhatsApp.
