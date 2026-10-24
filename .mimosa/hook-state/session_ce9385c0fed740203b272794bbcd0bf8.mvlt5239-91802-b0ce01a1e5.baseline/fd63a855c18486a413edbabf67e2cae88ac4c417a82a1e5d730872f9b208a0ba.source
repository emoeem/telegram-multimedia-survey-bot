/**
 * Transactional email via the Resend HTTP API. Workers-native (plain fetch),
 * no SMTP. Set RESEND_API_KEY + MAIL_FROM to enable; every failure is
 * logged-and-swallowed so auth flows can treat "sent" optimistically without
 * leaking whether an address exists.
 */
export interface EmailSendEnvironment {
  RESEND_API_KEY?: string | undefined;
  MAIL_FROM?: string | undefined;
}

export async function sendEmail(
  env: EmailSendEnvironment,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!apiKey || !from) {
    console.warn("Email sending not configured (RESEND_API_KEY / MAIL_FROM missing)");
    return false;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!response.ok) {
      console.error("Resend email failed", { status: response.status, to });
      return false;
    }
    return true;
  } catch (error) {
    console.error("Resend email error", { to, error });
    return false;
  }
}
