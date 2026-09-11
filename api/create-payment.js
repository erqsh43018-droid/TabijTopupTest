const admin = require("firebase-admin");

function getFirebaseApp() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) throw new Error("Firebase Admin environment variables are missing.");
  return admin.initializeApp({
    credential: admin.credential.cert({projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n")})
  });
}

module.exports = async function (req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});
  try {
    if (!process.env.RUPANTOR_API_KEY) return res.status(500).json({error:"Payment gateway is not configured."});
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required"});
    const app = getFirebaseApp();
    const decoded = await app.auth().verifyIdToken(authHeader.substring(7));
    const db = app.firestore();
    const body = req.body || {};
    const type = String(body.type || "");

    if (type === "wallet_add_money") {
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 10 || amount > 100000) return res.status(400).json({error:"Invalid amount"});
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      const user = userSnap.exists ? userSnap.data() || {} : {};
      return createGatewayPayment({req,res,db,decoded,type,amount,user,meta:{type,amount}});
    }

    if (type === "product_topup") {
      const price = Math.round(Number(body.price) * 100) / 100;
      if (!Number.isFinite(price) || price <= 0 || price > 100000) return res.status(400).json({error:"Invalid package price"});
      const playerId = String(body.playerId || "").trim();
      if (!playerId && String(body.gameName || "").toLowerCase() !== "spin offer") return res.status(400).json({error:"Player ID is required"});
      const orderRef = db.collection("rupantorPayments").doc();
      const orderId = orderRef.id;
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      const user = userSnap.exists ? userSnap.data() || {} : {};
      const host = String(req.headers.host || "").split(":")[0];
      if (!host) return res.status(400).json({error:"Request host unavailable"});
      const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
      const baseUrl = `${protocol}://${host}`;
      const successUrl = `${baseUrl}/?payment=success&orderId=${encodeURIComponent(orderId)}&transactionId={transaction_id}`;
      const cancelUrl = `${baseUrl}/?payment=cancel&orderId=${encodeURIComponent(orderId)}`;
      await orderRef.set({
        userId:decoded.uid,userEmail:decoded.email || user.email || "",userName:user.name || decoded.name || "User",
        type:"product_topup",amount:price,status:"PENDING",paymentMethod:"Tabij Pay",playerId,serviceId:String(body.serviceId||""),productId:String(body.productId||""),
        gameName:String(body.gameName||"Gaming Service"),serviceName:String(body.serviceName||"Service"),productName:String(body.productName||"Package"),
        spinRewardId: body.spinRewardId == null ? null : Number(body.spinRewardId), spinRewardName: body.spinRewardName || null, spinDateKey: body.spinDateKey || null,
        createdAt:admin.firestore.FieldValue.serverTimestamp()
      });
      return callGateway({req,res,orderRef,orderId,decoded,user,type,amount:price,successUrl,cancelUrl,meta:{orderId,uid:decoded.uid,type,amount:price,playerId,serviceId:body.serviceId||"",productId:body.productId||"",gameName:body.gameName||"Gaming Service",serviceName:body.serviceName||"Service",productName:body.productName||"Package"}});
    }
    return res.status(400).json({error:"Invalid payment type"});
  } catch (error) {
    console.error("CREATE PAYMENT ERROR:", error);
    return res.status(500).json({error:"Unable to create payment"});
  }
};

async function createGatewayPayment({req,res,db,decoded,type,amount,user,meta}) {
  const orderRef = db.collection("rupantorPayments").doc();
  const orderId = orderRef.id;
  const host = String(req.headers.host || "").split(":")[0];
  if (!host) return res.status(400).json({error:"Request host unavailable"});
  const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const baseUrl = `${protocol}://${host}`;
  const successUrl = `${baseUrl}/?payment=success&orderId=${encodeURIComponent(orderId)}&transactionId={transaction_id}`;
  const cancelUrl = `${baseUrl}/?payment=cancel&orderId=${encodeURIComponent(orderId)}`;
  await orderRef.set({userId:decoded.uid,userEmail:decoded.email||user.email||"",userName:user.name||decoded.name||"User",type,amount,status:"PENDING",paymentMethod:"Tabij Pay",createdAt:admin.firestore.FieldValue.serverTimestamp()});
  return callGateway({req,res,orderRef,orderId,decoded,user,type,amount,successUrl,cancelUrl,meta});
}

async function callGateway({req,res,orderRef,orderId,decoded,user,type,amount,successUrl,cancelUrl,meta}) {
  const host = String(req.headers.host || "").split(":")[0];
  const checkoutResponse = await fetch("https://payment.rupantorpay.com/api/payment/checkout",{
    method:"POST",headers:{"Content-Type":"application/json","X-API-KEY":process.env.RUPANTOR_API_KEY,"X-CLIENT":host},
    body:JSON.stringify({fullname:user.name||decoded.name||"Customer",email:decoded.email||user.email||"customer@example.com",amount,success_url:successUrl,cancel_url:cancelUrl,meta_data:meta})
  });
  const raw=await checkoutResponse.text(); let data={}; try{data=JSON.parse(raw)}catch(_){ }
  if(!checkoutResponse.ok||!data.payment_url){
    await orderRef.update({status:"PAYMENT_CREATION_FAILED",error:data||raw||null,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    return res.status(502).json({error:data.message||"Unable to create payment"});
  }
  await orderRef.update({paymentUrl:data.payment_url,gatewayResponse:data,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  return res.status(200).json({success:true,orderId,payment_url:data.payment_url});
}
