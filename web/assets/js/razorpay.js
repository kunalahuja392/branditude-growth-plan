// Razorpay online payment for a pending Branditude payment (UPI, cards, netbanking, wallets).
// The razorpay edge function creates the order and verifies the signature; the payment is then confirmed automatically.
export const rzpOn = (settings) => !!settings?.razorpay?.enabled;

let loading = null;
const loadScript = () => (window.Razorpay ? Promise.resolve() : (loading ||= new Promise((res, rej) => {
  const s = document.createElement("script"); s.src = "https://checkout.razorpay.com/v1/checkout.js"; s.onload = res; s.onerror = () => { loading = null; rej(new Error("Couldn't load the payment window. Check your internet and try again.")); }; document.head.append(s);
})));

async function call(sb, body) {
  const { data, error } = await sb.functions.invoke("razorpay", { body });
  if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch {} throw new Error(m); }
  return data;
}

// Resolves "paid" or "closed" (customer closed the window). Throws with a readable message on failure.
export async function payOnline(sb, paymentId) {
  const [o] = await Promise.all([call(sb, { action: "order", payment_id: paymentId }), loadScript()]);
  return new Promise((resolve, reject) => {
    const rz = new window.Razorpay({
      key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: o.name, description: o.description, prefill: o.prefill,
      theme: { color: "#f07a1a" },
      handler: async (r) => { try { await call(sb, { action: "verify", payment_id: paymentId, ...r }); resolve("paid"); } catch (e) { reject(e); } },
      modal: { ondismiss: () => resolve("closed") },
    });
    rz.on("payment.failed", (r) => reject(new Error(r?.error?.description || "The payment didn't go through. No money was taken, or it will be refunded.")));
    rz.open();
  });
}
