require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

/* =========================
   🔥 FIREBASE INIT (ANTI CRASH)
========================= */
let db;

try {
  const serviceAccount = {
    type: "service_account",
    project_id: "isimu-enterpreneur",
    private_key_id: process.env.PRIVATE_KEY_ID,
    private_key: process.env.PRIVATE_KEY
      ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n")
      : "",
    client_email: process.env.CLIENT_EMAIL,
    client_id: process.env.CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token"
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://isimu-enterpreneur.firebaseio.com"
  });

  db = admin.database();
  console.log("🔥 Firebase CONNECTED");

} catch (error) {
  console.log("❌ Firebase ERROR:", error.message);
}

/* =========================
   ROOT
========================= */
app.get("/", (req, res) => {
  res.send("API JUAL PULSA READY 🔥");
});

/* =========================
   🔥 TEST FIREBASE
========================= */
app.get("/test-firebase", async (req, res) => {
  try {
    if (!db) return res.send("Firebase belum connect");

    await db.ref("test").set({
      nama: "test berhasil"
    });

    res.send("OK");

  } catch (err) {
    res.send("ERROR: " + err.message);
  }
});

/* =========================
   SIGN DIGIFLAZZ
========================= */
function createSign(username, apiKey, refId) {
  return crypto
    .createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");
}

/* =========================
   📦 AMBIL PRODUK DIGIFLAZZ
========================= */
app.get("/produk", async (req, res) => {
  try {
    if (!db) return res.json({ error: "Firebase belum connect" });

    const sign = crypto
      .createHash("md5")
      .update(process.env.DIGI_USERNAME + process.env.DIGI_API_KEY + "pricelist")
      .digest("hex");

    const response = await axios.post(
      "https://api.digiflazz.com/v1/price-list",
      {
        cmd: "prepaid",
        username: process.env.DIGI_USERNAME,
        sign: sign
      }
    );

    const produk = response.data.data;

    let total = 0;

    for (let item of produk) {
      if (!item.buyer_sku_code || !item.product_name) continue;

      await db.ref("produk/" + item.buyer_sku_code).set({
        nama: item.product_name || "",
        harga: item.price || 0,
        kategori: item.category || "",
        status: item.buyer_product_status || false
      });

      total++;
    }

    res.json({ success: true, total });

  } catch (error) {
    res.json({ error: error.message });
  }
});

/* =========================
   🔥 BELI PRODUK
========================= */
app.get("/beli", async (req, res) => {
  try {
    if (!db) return res.json({ error: "Firebase belum connect" });

    const { produk, tujuan, user_id } = req.query;

    if (!produk || !tujuan || !user_id) {
      return res.json({ error: "produk, tujuan, user_id wajib" });
    }

    const refId = "TRX-" + Date.now();

    const sign = createSign(
      process.env.DIGI_USERNAME,
      process.env.DIGI_API_KEY,
      refId
    );

    const response = await axios.post(
      "https://api.digiflazz.com/v1/transaction",
      {
        username: process.env.DIGI_USERNAME,
        buyer_sku_code: produk,
        customer_no: tujuan,
        ref_id: refId,
        sign: sign
      }
    );

    // simpan ke firebase
    await db.ref("transaksi/" + refId).set({
      user_id,
      produk,
      tujuan,
      response: response.data,
      created_at: Date.now()
    });

    res.json(response.data);

  } catch (error) {
    res.json({
      error: error.response?.data || error.message
    });
  }
});

/* =========================
   🔍 CEK STATUS
========================= */
app.get("/cek", async (req, res) => {
  try {
    const { ref_id } = req.query;

    if (!ref_id) {
      return res.json({ error: "ref_id wajib" });
    }

    const sign = createSign(
      process.env.DIGI_USERNAME,
      process.env.DIGI_API_KEY,
      ref_id
    );

    const response = await axios.post(
      "https://api.digiflazz.com/v1/transaction",
      {
        username: process.env.DIGI_USERNAME,
        ref_id,
        sign
      }
    );

    res.json(response.data);

  } catch (error) {
    res.json({
      error: error.response?.data || error.message
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server jalan 🔥");
});