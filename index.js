require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ==========================
// 🔥 FIREBASE INIT
// ==========================
let db = null;
let firebaseStatus = { initialized: false, error: null };

try {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }

  const serviceAccount = {
    type: "service_account",
    project_id: "isimu-enterpreneur",
    private_key_id: process.env.PRIVATE_KEY_ID,
    private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.CLIENT_EMAIL,
    client_id: process.env.CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token"
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://isimu-enterpreneur-default-rtdb.firebaseio.com"
  });

  db = admin.database();
  firebaseStatus.initialized = true;
  console.log("🔥 Firebase initialized successfully");
} catch (err) {
  firebaseStatus.error = err.message;
  console.error("❌ Firebase initialization failed:", err.message);
}

// ==========================
// 🩺 HEALTH CHECK
// ==========================
app.get("/health", (req, res) => {
  res.status(firebaseStatus.initialized ? 200 : 503).json({
    status: firebaseStatus.initialized ? "ok" : "degraded",
    firebase: {
      initialized: firebaseStatus.initialized,
      error: firebaseStatus.error || null
    }
  });
});

// ==========================
// 🔑 SIGN DIGIFLAZZ
// ==========================
function createSign(username, apiKey, refId) {
  return crypto
    .createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");
}

// ==========================
// ROOT
// ==========================
app.get("/", (req, res) => {
  res.send("API JUAL PULSA READY 🔥");
});

// ==========================
// 📦 AMBIL & SIMPAN PRODUK
// ==========================
app.get("/produk", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firebase tidak tersedia", detail: firebaseStatus.error });
  try {
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

    const raw = response.data.data;

    // Log the actual structure returned by Digiflazz for debugging
    console.log("📦 Digiflazz response.data.data type:", typeof raw, Array.isArray(raw) ? "(array)" : "(non-array)");
    console.log("📦 Digiflazz response.data.data sample:", JSON.stringify(raw)?.slice(0, 300));

    // Normalise to array: Digiflazz may return an array or an object keyed by SKU
    let produk;
    if (Array.isArray(raw)) {
      produk = raw;
    } else if (raw && typeof raw === "object") {
      produk = Object.values(raw);
    } else {
      throw new Error("Format response Digiflazz tidak dikenali: " + typeof raw);
    }

    for (let item of produk) {
      await db.ref("produk/" + item.buyer_sku_code).set({
        nama: item.product_name,
        harga: item.price,
        kategori: item.category,
        status: item.buyer_product_status
      });
    }

    res.json({ success: true, total: produk.length });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ==========================
// 💰 BELI PRODUK
// ==========================
app.get("/beli", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firebase tidak tersedia", detail: firebaseStatus.error });
  const { produk, tujuan, user_id } = req.query;

  if (!produk || !tujuan || !user_id) {
    return res.json({ error: "produk, tujuan, user_id wajib" });
  }

  const refId = "TRX-" + Date.now();

  try {
    // 🔹 ambil user
    const userSnap = await db.ref("users/" + user_id).once("value");
    const user = userSnap.val();

    if (!user) return res.json({ error: "User tidak ditemukan" });

    // 🔹 ambil produk
    const produkSnap = await db.ref("produk/" + produk).once("value");
    const produkData = produkSnap.val();

    if (!produkData) return res.json({ error: "Produk tidak ditemukan" });

    // 🔹 cek saldo
    if (user.saldo < produkData.harga) {
      return res.json({ error: "Saldo tidak cukup" });
    }

    // 🔹 potong saldo
    const sisaSaldo = user.saldo - produkData.harga;
    await db.ref("users/" + user_id + "/saldo").set(sisaSaldo);

    // 🔹 sign digiflazz
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

    const result = response.data.data;

    // 🔹 simpan transaksi
    await db.ref("transaksi/" + refId).set({
      user_id,
      produk,
      tujuan,
      harga: produkData.harga,
      status: result.status,
      sn: result.sn || "",
      response: JSON.stringify(result),
      created_at: Date.now()
    });

    // 🔹 index transaksi user
    await db.ref("user_transaksi/" + user_id + "/" + refId).set(true);

    // 🔹 simpan mutasi
    await db.ref("mutasi/" + refId).set({
      user_id,
      tipe: "debit",
      nominal: produkData.harga,
      keterangan: "Pembelian " + produk,
      created_at: Date.now()
    });

    res.json({
      success: true,
      data: result,
      saldo_sisa: sisaSaldo
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ==========================
// 🔍 CEK STATUS
// ==========================
app.get("/cek", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firebase tidak tersedia", detail: firebaseStatus.error });
  const { ref_id } = req.query;

  if (!ref_id) return res.json({ error: "ref_id wajib" });

  try {
    const sign = createSign(
      process.env.DIGI_USERNAME,
      process.env.DIGI_API_KEY,
      ref_id
    );

    const response = await axios.post(
      "https://api.digiflazz.com/v1/transaction",
      {
        username: process.env.DIGI_USERNAME,
        ref_id: ref_id,
        sign: sign
      }
    );

    const result = response.data.data;

    // update status di firebase
    await db.ref("transaksi/" + ref_id).update({
      status: result.status,
      sn: result.sn || ""
    });

    res.json(result);

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ==========================
// 🔔 CALLBACK DIGIFLAZZ
// ==========================
app.post("/callback", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firebase tidak tersedia", detail: firebaseStatus.error });
  try {
    const data = req.body;

    const refId = data.ref_id;

    // simpan log
    await db.ref("log_callback/" + refId).set({
      data: JSON.stringify(data),
      created_at: Date.now()
    });

    // update transaksi
    await db.ref("transaksi/" + refId).update({
      status: data.status,
      sn: data.sn || ""
    });

    res.json({ success: true });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ==========================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server jalan di port 3000");
});

// ==========================cek ip
app.get("/ip", (req, res) => {
  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress;

  res.json({ ip });
});

//==============tes firebash
app.get("/test-firebase", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firebase tidak tersedia", detail: firebaseStatus.error });
  try {
    await db.ref("test").set({ nama: "test berhasil" });
    res.send("OK");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});