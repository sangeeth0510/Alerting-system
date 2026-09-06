import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload.record
    const oldRecord = payload.old_record

    if (!record || record.status !== "triggered" || oldRecord?.status === "triggered") {
      return new Response("ignored", { status: 200 })
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(record.user_id)
    if (userErr || !userData?.user?.email) throw new Error("could not resolve user email")

    const assetLabel = record.asset === "gold" ? "Gold" : "Silver"
    const condLabel = record.condition === "above" ? "risen above" : "fallen below"

    const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: Deno.env.get("EMAILJS_SERVICE_ID"),
        template_id: Deno.env.get("EMAILJS_TEMPLATE_ID"),
        user_id: Deno.env.get("EMAILJS_PUBLIC_KEY"),
        accessToken: Deno.env.get("EMAILJS_PRIVATE_KEY"),
        template_params: {
          to_email: userData.user.email,
          asset: assetLabel,
          condition: condLabel,
          target: record.target,
        },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`EmailJS API error: ${res.status} ${errText}`)
    }

    return new Response("sent", { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response(String(err), { status: 500 })
  }
})