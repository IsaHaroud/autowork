import { config } from "../config.ts";
import { findOrCreateCustomerByWhatsapp } from "../db/database.ts";

/**
 * WhatsApp Cloud API - test number: +1 (555) 199-2487 / ID 1208116642395683
 */

export async function whatsappWebhookHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // GET verification (Meta calls this when you save webhook)
  if (req.method === "GET" && url.pathname === "/webhook/whatsapp") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === config.whatsappVerifyToken) {
      console.log("✅ WhatsApp webhook verified");
      return new Response(challenge ?? "", { status: 200 });
    }
    console.warn(`❌ WhatsApp verify failed: token=${token} expected=${config.whatsappVerifyToken}`);
    return new Response("Forbidden", { status: 403 });
  }

  // POST - incoming messages
  if (req.method === "POST" && url.pathname === "/webhook/whatsapp") {
    try {
      const body = (await req.json()) as any;
      // console.log("📩 WhatsApp webhook:", JSON.stringify(body, null, 2));

      // Handle Meta test ping: entry[0].changes[0].value.statuses
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Incoming messages: value.messages
      if (value?.messages?.length) {
        for (const msg of value.messages) {
          const from: string = msg.from; // e.g. 2126XXXXXXXX
          const text: string | undefined = msg.text?.body;
          const name: string | undefined = value.contacts?.[0]?.profile?.name;
          console.log(`📩 WhatsApp from ${from} (${name ?? "?"}) : ${text ?? `[${msg.type}]`}`);

          if (!from) continue;

          // Auto-create customer on first WhatsApp message (same as Telegram /start)
          const { id: customerId, isNew } = findOrCreateCustomerByWhatsapp({
            whatsappId: from,
            name,
          });
          console.log(`   → Customer ${customerId} ${isNew ? "(new)" : "(existing)"}`);

          // Auto-reply parity with Telegram /start: return ID + ask to describe task
          // Only reply if it's a text message to avoid loops
          if (msg.type === "text") {
            const reply =
              `👋 Welcome${name ? ` ${name}` : ""}!\n` +
              `🆔 Your WhatsApp: +${from}\n` +
              `👤 Customer ID: ${customerId} ${isNew ? "(new)" : ""}\n\n` +
              `Describe the repetitive task you want to automate.\n` +
              `Owner will add your service, you can test then pay monthly.\n\n` +
              `Owner WhatsApp: ${config.ownerWhatsapp}`;

            // Don't await blocking? but we should reply before Meta timeout (20s)
            await sendWhatsAppMessage(from, reply).catch((e) => console.error("auto-reply failed", e));
          }
        }
      } else if (value?.statuses) {
        // delivery/read receipts - just log
        console.log("ℹ️ WhatsApp status:", JSON.stringify(value.statuses));
      } else {
        console.log("ℹ️ WhatsApp webhook unknown payload:", JSON.stringify(body).slice(0, 500));
      }
    } catch (e) {
      console.error("WhatsApp webhook parse error:", e);
      // still return 200 to stop Meta retry
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Not Found", { status: 404 });
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<any> {
  const token = config.whatsappToken;
  const phoneId = config.whatsappPhoneNumberId;

  if (!token || !phoneId) {
    console.warn("⚠️ WhatsApp not configured (WHATSAPP_TOKEN/PHONE_NUMBER_ID missing). Would send:", { to, text: text.slice(0, 100) });
    return { warning: "not_configured" };
  }

  const cleanTo = to.replace(/^\+/, "").replace(/\s/g, "");
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: cleanTo,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("❌ WhatsApp send failed:", JSON.stringify(data));
    // Helpful hints for test number
    if ((data as any)?.error?.code === 131030 || String(data).includes("131030")) {
      console.error("→ Test numbers can only message RECIPIENTS you added in Meta dashboard → WhatsApp → API Setup → Manage phone number → To. Add +212... and verify code.");
    }
    if ((data as any)?.error?.code === 190) {
      console.error("→ Access token expired/invalid. Generate new one in Meta dashboard (valid ~1h for test). Update WHATSAPP_TOKEN in .env");
    }
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
  }
  console.log(`✅ WhatsApp sent to ${cleanTo}:`, JSON.stringify(data));
  return data;
}

export function buildWhatsAppWelcome(waId: string, customerId: string): string {
  return `👋 Welcome! Your WhatsApp: ${waId}\n👤 Customer ID: ${customerId}\n\nContact owner: ${config.ownerWhatsapp} if you need help.`;
}
