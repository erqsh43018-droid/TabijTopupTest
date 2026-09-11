const admin = require("firebase-admin");

function getFirebaseApp(){
  if(admin.apps.length) return admin.app();
  const projectId=process.env.FIREBASE_PROJECT_ID, clientEmail=process.env.FIREBASE_CLIENT_EMAIL, privateKey=process.env.FIREBASE_PRIVATE_KEY;
  if(!projectId||!clientEmail||!privateKey) throw new Error("Firebase Admin environment variables are missing.");
  return admin.initializeApp({credential:admin.credential.cert({projectId,clientEmail,privateKey:privateKey.replace(/\\n/g,"\n")})});
}

module.exports = async function(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  try{
    if(!process.env.RUPANTOR_API_KEY) return res.status(500).json({error:"Payment gateway is not configured."});
    const authHeader=req.headers.authorization||"";
    if(!authHeader.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required"});
    const app=getFirebaseApp(),decoded=await app.auth().verifyIdToken(authHeader.substring(7)),db=app.firestore();
    const body=req.body||{},orderId=String(body.orderId||"").trim(),transactionId=String(body.transactionId||"").trim();
    if(!orderId||!transactionId) return res.status(400).json({error:"Missing payment information"});
    const orderRef=db.collection("rupantorPayments").doc(orderId),snap=await orderRef.get();
    if(!snap.exists) return res.status(404).json({error:"Payment order not found"});
    const order=snap.data()||{};
    if(order.userId!==decoded.uid) return res.status(403).json({error:"Payment order does not belong to this user"});
    if(order.status==="COMPLETED") return res.status(200).json({success:true,alreadyProcessed:true,type:order.type,amount:Number(order.amount||0)});
    if(order.status!=="PENDING") return res.status(409).json({error:"Payment order is no longer pending"});

    const host=String(req.headers.host||"").split(":")[0];
    const verifyResponse=await fetch("https://payment.rupantorpay.com/api/payment/verify-payment",{method:"POST",headers:{"Content-Type":"application/json","X-API-KEY":process.env.RUPANTOR_API_KEY,"X-CLIENT":host},body:JSON.stringify({transaction_id:transactionId})});
    const raw=await verifyResponse.text(); let payment={}; try{payment=JSON.parse(raw)}catch(_){ }
    const gatewayStatus=String(payment.status||"").toUpperCase();
    if(!verifyResponse.ok||gatewayStatus!=="COMPLETED"){
      await orderRef.update({lastVerifyStatus:gatewayStatus||"ERROR",lastVerifyResponse:payment||raw,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return res.status(400).json({error:"Payment was not completed",gatewayStatus:gatewayStatus||"ERROR"});
    }
    const gatewayAmount=Number(payment.amount),orderAmount=Number(order.amount);
    if(!Number.isFinite(gatewayAmount)||gatewayAmount!==orderAmount){
      await orderRef.update({status:"AMOUNT_MISMATCH",gatewayAmount,expectedAmount:orderAmount,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return res.status(400).json({error:"Payment amount mismatch"});
    }

    const result=await db.runTransaction(async tx=>{
      const latestSnap=await tx.get(orderRef),latest=latestSnap.data()||{};
      if(latest.status==="COMPLETED") return {alreadyProcessed:true,type:latest.type,amount:Number(latest.amount||orderAmount)};
      if(latest.status!=="PENDING") throw new Error("Payment order is no longer pending");
      const userRef=db.collection("users").doc(order.userId);
      const userSnap=await tx.get(userRef),user=userSnap.exists?userSnap.data()||{}:{};
      const now=admin.firestore.FieldValue.serverTimestamp();
      if(order.type==="wallet_add_money"){
        const currentBalance=Number(user.balance||0);
        tx.set(userRef,{balance:Math.round((currentBalance+orderAmount)*100)/100,updatedAt:now},{merge:true});
        tx.update(orderRef,{status:"COMPLETED",gatewayStatus,transactionId,trxId:payment.trx_id||transactionId,verifiedAt:now,updatedAt:now});
        const transactionRef=db.collection("transactions").doc(String(payment.trx_id||transactionId));
        tx.set(transactionRef,{userId:order.userId,userEmail:order.userEmail||decoded.email||"",type:"wallet_topup",method:"Tabij Pay",amount:orderAmount,transactionId,paymentId:orderRef.id,status:"completed",date:now},{merge:true});
        return {alreadyProcessed:false,type:"wallet_add_money",amount:orderAmount};
      }
      if(order.type==="product_topup"){
        const productOrderRef=db.collection("orders").doc();
        tx.set(productOrderRef,{userId:order.userId,userEmail:order.userEmail||decoded.email||"",userName:order.userName||user.name||"User",gameName:order.gameName||"Gaming Service",serviceName:order.serviceName||"Service",productName:order.productName||"Package",playerId:order.playerId||"",price:orderAmount,status:"pending",type:"uid",paymentMethod:"Tabij Pay",paymentId:orderRef.id,transactionId,trxId:payment.trx_id||transactionId,date:now, ...(order.spinRewardId?{isSpinReward:true,spinRewardId:Number(order.spinRewardId),spinRewardName:order.spinRewardName||"",spinDateKey:order.spinDateKey||""}: {})});
        if(order.spinRewardId&&order.spinDateKey){
          const spinRef=db.collection("dailySpins").doc(order.userId+"_"+order.spinDateKey);
          const spinSnap=await tx.get(spinRef);
          if(spinSnap.exists){const sd=spinSnap.data()||{};if(sd.redeemed===true) throw new Error("This Spin Reward has already been used");tx.update(spinRef,{redeemed:true,redeemedAt:now,redeemedOrderId:productOrderRef.id});}
        }
        tx.update(orderRef,{status:"COMPLETED",gatewayStatus,transactionId,trxId:payment.trx_id||transactionId,verifiedAt:now,linkedOrderId:productOrderRef.id,updatedAt:now});
        const transactionRef=db.collection("transactions").doc(String(payment.trx_id||transactionId));
        tx.set(transactionRef,{userId:order.userId,userEmail:order.userEmail||decoded.email||"",type:"product_payment",method:"Tabij Pay",amount:orderAmount,transactionId,paymentId:orderRef.id,status:"completed",orderId:productOrderRef.id,date:now},{merge:true});
        return {alreadyProcessed:false,type:"product_topup",amount:orderAmount,orderId:productOrderRef.id};
      }
      throw new Error("Unknown payment type");
    });
    return res.status(200).json({success:true,...result});
  }catch(error){
    console.error("VERIFY PAYMENT ERROR:",error);
    return res.status(500).json({error:error.message||"Payment verification failed"});
  }
};
