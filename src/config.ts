function getEnv(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = Bun.env[k] ?? Bun.env[k.toUpperCase()] ?? Bun.env[k.toLowerCase()];
    if (v) return v;
  }
  return undefined;
}

export const config = {
  get botToken(): string {
    const token =
      getEnv("BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "bot_token", "TELEGRAM_TOKEN") ?? "";
    if (!token) {
      console.error(
        "❌ Missing BOT_TOKEN in .env\n" +
          "   Add: BOT_TOKEN=your_token_from_BotFather\n" +
          "   See .env.example"
      );
    }
    return token;
  },

  get adminId(): number | undefined {
    const raw = getEnv("ADMIN_TELEGRAM_ID", "ADMIN_ID", "OWNER_TELEGRAM_ID");
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  },

  get ownerWhatsapp(): string {
    return (
      getEnv("OWNER_WHATSAPP_NUMBER", "OWNER_WHATSAPP", "WHATSAPP_NUMBER", "OWNER_PHONE") ??
      "+212600000000"
    );
  },

  get whatsappToken(): string | undefined {
    return getEnv("WHATSAPP_TOKEN", "WHATSAPP_ACCESS_TOKEN");
  },

  get whatsappPhoneNumberId(): string | undefined {
    return getEnv("WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PHONE_ID");
  },

  get whatsappVerifyToken(): string {
    return getEnv("WHATSAPP_VERIFY_TOKEN", "WHATSAPP_WEBHOOK_VERIFY_TOKEN") ?? "autowork_verify";
  },

  get databasePath(): string {
    return getEnv("DATABASE_PATH", "DB_PATH", "SQLITE_PATH") ?? "./data/autowork.db";
  },

  get port(): number {
    const raw = getEnv("PORT");
    return raw ? Number(raw) : 3000;
  },

  get adminToken(): string | undefined {
    return getEnv("ADMIN_TOKEN", "ADMIN_API_TOKEN", "DASHBOARD_TOKEN");
  },

  get telegramBotUsername(): string | undefined {
    return getEnv("TELEGRAM_BOT_USERNAME", "BOT_USERNAME");
  },
};
