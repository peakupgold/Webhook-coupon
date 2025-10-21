// Vercel serverless function for creating Shopify customers
// Place this file at: /api/webhook.js

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, source, discount_code, tags } = req.body;

    // Validate email
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Get environment variables
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;

    if (!accessToken || !shopDomain) {
      return res.status(500).json({ error: 'Missing Shopify configuration' });
    }

    // Create customer data
    const customerData = {
      email: email,
      accepts_marketing: true,
      tags: tags || 'newsletter,discount-popup,popup-subscriber',
      note: `Subscribed via discount popup (${source || 'unknown'}) on ${new Date().toLocaleDateString()}. Interested in discount: ${discount_code || 'N/A'}`,
      marketing_opt_in_level: 'confirmed_opt_in',
      verified_email: true
    };

    // Create customer via Shopify Admin API
    const customer = await createShopifyCustomer(customerData, accessToken, shopDomain);

    console.log('Customer created:', customer.id);

    return res.status(200).json({
      success: true,
      customer_id: customer.id,
      email: customer.email,
      message: 'Customer created successfully'
    });

  } catch (error) {
    console.error('Customer creation error:', error);
    
    // Handle specific Shopify API errors
    if (error.message.includes('422')) {
      return res.status(200).json({
        success: true,
        message: 'Customer already exists - updated marketing consent',
        note: 'Email was already in system'
      });
    }

    return res.status(500).json({
      error: 'Failed to create customer',
      details: error.message
    });
  }
}

/**
 * Creates a customer using Shopify Admin API
 */
async function createShopifyCustomer(customerData, accessToken, shopDomain) {
  const url = `https://${shopDomain}/admin/api/2023-10/customers.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({
      customer: customerData
    })
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Shopify API Error: ${response.status} - ${errorData}`);
  }

  const result = await response.json();
  return result.customer;
}

/**
 * Validates email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}