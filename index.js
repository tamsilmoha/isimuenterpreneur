require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

/* =========================
   FIREBASE INIT (SAFE)
========================= */
let db = null;

try {
  if (
    process.env.PRIVATE_KEY &&
    process.env.CLIENT_EMAIL &&
    process.env.CLIENT_ID
  ) {
    const serviceAccount = {
      type: "service_account",
      project_id: "isimu-enterpreneur",
      private_key_id: process.env.PRIVATE_KEY_ID,
      private_key: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.CLIENT_EMAIL,
      client_id: process.env.CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token"
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://isimu-enterpreneur-default-rtdb.asia-southeast1.firebasedatabase.app"
    });

    db = admin.database();
    console.log("🔥 Firebase CONNECTED");
  } else {
    console.log("❌ Firebase ENV belum lengkap");
  }
} catch (error) {
  console.log("❌ Firebase init gagal");
}

/* =========================
   ROOT
========================= */
app.get("/", (req, res) => {
  res.send("API JUAL PULSA READY 🔥");
});

/* =========================
   TEST FIREBASE
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
function createSign(username, apiKey, ref_id) {
  return crypto
    .createHash("md5")
    .update(username + apiKey + ref_id)
    .digest("hex");
}

/* =========================
   PRODUK DIGIFLAZZ → FIREBASE
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

    if (!Array.isArray(response.data.data)) {
      return res.json({
        error: "Digiflazz error",
        message: response.data.message
      });
    }

    const produk = response.data.data;

    let total = 0;

    for (let item of produk) {
      if (!item.buyer_sku_code || !item.product_name) continue;

      await db.ref("produk/" + item.buyer_sku_code).set({
        nama: item.product_name || "",
        harga: Number(item.price) || Number(item.selling_price) || Number(item.buyer_price) || 0,
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
   BELI PRODUK (SERVER SIDE)
========================= */
app.get("/beli", async (req, res) => {
  try {
    if (!db) return res.json({ error: "Firebase belum connect" });

    const { produk, tujuan, user_id } = req.query;

    if (!produk || !tujuan || !user_id) {
      return res.json({ error: "produk, tujuan, user_id wajib" });
    }

    const userSnap = await db.ref("users/" + user_id).once("value");
    const user = userSnap.val();

    if (!user) return res.json({ error: "User tidak ditemukan" });

    const produkSnap = await db.ref("produk").once("value");

    let produkData = null;

    produkSnap.forEach(child => {
      if (child.key.toLowerCase() === produk.toLowerCase()) {
        produkData = child.val();
      }
    });

    if (!produkData) {
      return res.json({ error: "Produk tidak ditemukan" });
    }

    const harga = produkData.harga;

    if (user.saldo < harga) {
      return res.json({ error: "Saldo tidak cukup" });
    }

    const ref_id = "TRX-" + Date.now();

    await db.ref("users/" + user_id + "/saldo")
      .set(user.saldo - harga);

    const sign = createSign(
      process.env.DIGI_USERNAME,
      process.env.DIGI_API_KEY,
      ref_id
    );

    const response = await axios.post(
      "https://api.digiflazz.com/v1/transaction",
      {
        username: process.env.DIGI_USERNAME,
        buyer_sku_code: produk,
        customer_no: tujuan,
        ref_id: ref_id,
        sign: sign
      }
    );

    await db.ref("transaksi/" + ref_id).set({
      user_id,
      produk,
      tujuan,
      harga,
      status: response.data.data?.status || "Pending",
      response: response.data,
      created_at: Date.now()
    });

    await db.ref("mutasi/" + ref_id).set({
      user_id,
      tipe: "debit",
      nominal: harga,
      keterangan: "Beli " + produk,
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
   CEK STATUS + UPDATE
========================= */
app.get("/cek", async (req, res) => {
  try {
    const ref_id = req.query.ref_id;

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

    const data = response.data.data;

    await db.ref("transaksi/" + ref_id).update({
      status: data.status,
      sn: data.sn || ""
    });

    if (data.status === "Gagal") {
      const trxSnap = await db.ref("transaksi/" + ref_id).once("value");
      const trx = trxSnap.val();

      await db.ref("users/" + trx.user_id + "/saldo")
        .transaction(saldo => saldo + trx.harga);
    }

    res.json(data);
  } catch (error) {
    res.json({
      error: error.response?.data || error.message
    });
  }
});

setInterval(async () => {
  try {
    if (!db) return;

    const snap = await db.ref("transaksi").once("value");

    snap.forEach(async (child) => {
      const trx = child.val();
      const ref_id = child.key;

      if (trx.status === "Pending") {

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

        const data = response.data.data;

        await db.ref("transaksi/" + ref_id).update({
          status: data.status,
          sn: data.sn || ""
        });

        // 🔥 refund otomatis
        if (data.status === "Gagal") {
          await db.ref("users/" + trx.user_id + "/saldo")
            .transaction(saldo => saldo + trx.harga);
        }
      }
    });

  } catch (err) {}
}, 10000); // tiap 10 detik

/* =========================
   START SERVER
========================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server jalan 🔥");
});