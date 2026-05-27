require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing for API requests
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for active transactions
const transactions = new Map();

// PayHero API Base URL
const PAYHERO_API_URL = 'https://backend.payhero.co.ke/api/v2';

// Generate PayHero Basic Auth header
function getPayHeroAuthHeader() {
  const username = process.env.PAYHERO_API_USERNAME || '';
  const password = process.env.PAYHERO_API_PASSWORD || '';

  if (!username || !password || username.includes('YOUR_') || password.includes('YOUR_')) {
    throw new Error('PayHero API credentials are not configured in .env');
  }

  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// =========================================================================
// Step 1: Initiate M-PESA STK Push via PayHero
// =========================================================================
app.post('/api/boosts/paye', async (req, res) => {
  const { phone, amount } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone number is required.' });
  }

  // Normalize phone number format (PayHero accepts 07XX or 01XX)
  let cleanPhone = phone.replace(/[\s\-\+]/g, '');
  if (cleanPhone.startsWith('254')) {
    cleanPhone = '0' + cleanPhone.slice(3);
  }

  if (!cleanPhone.match(/^0[17]\d{8}$/)) {
    return res.status(400).json({ success: false, error: 'Invalid Kenyan phone number format. Must be 07XX... or 01XX...' });
  }

  try {
    const authHeader = getPayHeroAuthHeader();
    const channelId = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
    const callbackUrl = process.env.PAYHERO_CALLBACK_URL || 'https://yourdomain.com/api/payhero/callback';
    const payAmount = amount || 100;

    // Generate a unique external reference for tracking
    const externalRef = `CNW-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    console.log(`[PayHero] Initiating STK Push for ${cleanPhone} of Ksh ${payAmount} (ref: ${externalRef})...`);

    const response = await fetch(`${PAYHERO_API_URL}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: payAmount,
        phone_number: cleanPhone,
        channel_id: channelId,
        provider: 'm-pesa',
        external_reference: externalRef,
        callback_url: callbackUrl
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`[PayHero] API returned error:`, result);
      return res.status(400).json({
        success: false,
        error: result.message || result.error || 'PayHero STK Push request was rejected.'
      });
    }

    console.log(`[PayHero] STK Push sent successfully to ${cleanPhone}. Reference: ${externalRef}`);
    console.log(`[PayHero] Response:`, JSON.stringify(result, null, 2));

    // Store pending transaction state using external reference as the key
    transactions.set(externalRef, {
      externalRef,
      status: 'QUEUED',
      paid: false,
      phone: cleanPhone,
      amount: payAmount,
      payheroResponse: result,
      timestamp: new Date()
    });

    return res.status(200).json({
      success: true,
      boostId: externalRef,
      message: 'STK push initiated successfully via PayHero.'
    });

  } catch (error) {
    console.error(`[PayHero] STK Push Exception:`, error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Server failed to connect to PayHero API.'
    });
  }
});

// =========================================================================
// Step 2: Webhook to receive PayHero Callback
// =========================================================================
app.post('/api/payhero/callback', (req, res) => {
  console.log('[PayHero Callback] Received transaction update:', JSON.stringify(req.body, null, 2));

  try {
    const callbackData = req.body;
    const externalRef = callbackData.ExternalReference || callbackData.external_reference;
    const status = callbackData.Status || callbackData.status;

    if (externalRef) {
      const tx = transactions.get(externalRef);

      if (tx) {
        if (status === 'SUCCESS' || status === 'success') {
          console.log(`[PayHero Callback] Payment SUCCESS for ${tx.phone} of Ksh ${tx.amount}. Ref: ${externalRef}`);
          tx.status = 'COMPLETED';
          tx.paid = true;
        } else if (status === 'FAILED' || status === 'failed') {
          console.warn(`[PayHero Callback] Payment FAILED for ${tx.phone}. Ref: ${externalRef}`);
          tx.status = 'FAILED';
          tx.paid = false;
        }
        tx.callbackData = callbackData;
        transactions.set(externalRef, tx);
      } else {
        console.warn(`[PayHero Callback] Transaction reference not found in cache: ${externalRef}`);
        // Store it anyway for client checking
        transactions.set(externalRef, {
          externalRef,
          status: (status === 'SUCCESS' || status === 'success') ? 'COMPLETED' : 'FAILED',
          paid: (status === 'SUCCESS' || status === 'success'),
          callbackData,
          timestamp: new Date()
        });
      }
    }

    return res.status(200).json({ status: 'ok', message: 'Callback processed successfully.' });

  } catch (error) {
    console.error(`[PayHero Callback] Processing Error:`, error.message);
    return res.status(500).send('Internal Server Error processing callback.');
  }
});

// =========================================================================
// Step 3: Polling endpoint for client verification
// =========================================================================
app.get('/api/boosts/:id', async (req, res) => {
  const externalRef = req.params.id;
  const tx = transactions.get(externalRef);

  // If we already have a definitive status from callback, return it immediately
  if (tx && (tx.status === 'COMPLETED' || tx.status === 'FAILED')) {
    return res.status(200).json({
      success: true,
      paid: tx.paid,
      paymentStatus: tx.status
    });
  }

  // Otherwise, actively check PayHero for the latest status
  try {
    const authHeader = getPayHeroAuthHeader();
    const checkRes = await fetch(
      `${PAYHERO_API_URL}/transaction-status?reference=${encodeURIComponent(externalRef)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader
        }
      }
    );

    const statusData = await checkRes.json();
    console.log(`[PayHero Poll] Status for ${externalRef}:`, JSON.stringify(statusData, null, 2));

    const paymentStatus = statusData.status || statusData.Status || 'QUEUED';

    // Update our local cache
    if (tx) {
      if (paymentStatus === 'SUCCESS') {
        tx.status = 'COMPLETED';
        tx.paid = true;
      } else if (paymentStatus === 'FAILED') {
        tx.status = 'FAILED';
        tx.paid = false;
      }
      transactions.set(externalRef, tx);
    }

    return res.status(200).json({
      success: true,
      paid: paymentStatus === 'SUCCESS',
      paymentStatus: paymentStatus === 'SUCCESS' ? 'COMPLETED' : paymentStatus === 'FAILED' ? 'FAILED' : 'PENDING'
    });

  } catch (error) {
    console.error(`[PayHero Poll] Error checking status:`, error.message);

    // Fallback to local cache if API call fails
    if (tx) {
      return res.status(200).json({
        success: true,
        paid: tx.paid,
        paymentStatus: tx.status
      });
    }

    return res.status(200).json({
      success: true,
      paid: false,
      paymentStatus: 'PENDING'
    });
  }
});

// Catch-all route to serve index.html for SPA client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to view your app!`);
});
