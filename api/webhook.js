export default async function handler(req, res) {
  // Set comprehensive CORS headers immediately
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Add cache control headers
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Handle preflight OPTIONS request immediately
  if (req.method === 'OPTIONS') {
    console.log('✅ Handling CORS preflight request from:', origin);
    res.status(200).end();
    return;
  }

  // Only allow POST for actual requests
  if (req.method !== 'POST') {
    console.log('❌ Method not allowed:', req.method);
    return res.status(405).json({ 
      error: 'Method not allowed', 
      allowed: 'POST',
      received: req.method 
    });
  }

  console.log('🔍 Webhook request from origin:', origin);
  
  try {
    // Parse request body
    let requestBody = req.body;
    
    // Handle different body formats
    if (typeof requestBody === 'string') {
      try {
        requestBody = JSON.parse(requestBody);
      } catch (parseError) {
        console.error('❌ JSON parsing failed:', parseError.message);
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON in request body',
          details: parseError.message
        });
      }
    }

    console.log('📋 Received data:', requestBody);
    
    // Extract email from request
    const { email, source, discount_code } = requestBody;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
        received: requestBody
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
        email: email
      });
    }

    // Get environment variables
    const shopifyDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    
    if (!shopifyDomain || !accessToken) {
      console.error('❌ Missing Shopify credentials in environment');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error',
        details: 'Missing required environment variables'
      });
    }

    console.log('✅ Shopify credentials found');
    console.log('🔍 Domain:', shopifyDomain);

    // Search for existing customer
    const searchUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`;
    
    console.log('🔍 Searching for existing customer...');
    
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error('❌ Customer search failed:', searchResponse.status, errorText);
      return res.status(500).json({
        success: false,
        error: 'Failed to search customers',
        details: `Shopify API Error: ${searchResponse.status}`
      });
    }

    const searchData = await searchResponse.json();
    console.log('🔍 Search found', searchData.customers?.length || 0, 'customers');
    
    // If customer exists, update them
    if (searchData.customers && searchData.customers.length > 0) {
      const existingCustomer = searchData.customers[0];
      console.log('📝 Updating existing customer:', existingCustomer.id);
      
      const updateUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/${existingCustomer.id}.json`;
      const updateData = {
        customer: {
          id: existingCustomer.id,
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          },
          tags: existingCustomer.tags ? 
            `${existingCustomer.tags},newsletter,discount-popup,popup-subscriber` : 
            'newsletter,discount-popup,popup-subscriber'
        }
      };

      const updateResponse = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateData)
      });

      if (updateResponse.ok) {
        const updatedCustomer = await updateResponse.json();
        console.log('✅ Customer updated successfully');
        return res.status(200).json({
          success: true,
          message: 'Existing customer updated with marketing consent',
          customer_id: existingCustomer.id,
          email: email,
          existing_customer: true
        });
      } else {
        const updateError = await updateResponse.text();
        console.error('⚠️ Update failed, will try creating new:', updateError);
        // Continue to create new customer
      }
    }

    // Create new customer
    console.log('➕ Creating new customer...');
    const createUrl = `https://${shopifyDomain}/admin/api/2023-10/customers.json`;
    const customerData = {
      customer: {
        email: email,
        email_marketing_consent: {
          state: 'subscribed',
          opt_in_level: 'single_opt_in',
          consent_updated_at: new Date().toISOString()
        },
        tags: 'newsletter,discount-popup,popup-subscriber',
        note: `Customer created via discount popup. Source: ${source || 'popup'}. Discount: ${discount_code || 'WELCOME10'}. Created: ${new Date().toISOString()}`,
        metafields: [
          {
            namespace: 'popup',
            key: 'source',
            value: source || 'discount_popup',
            type: 'single_line_text_field'
          },
          {
            namespace: 'popup', 
            key: 'discount_code',
            value: discount_code || 'WELCOME10',
            type: 'single_line_text_field'
          }
        ]
      }
    };

    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(customerData)
    });

    if (createResponse.ok) {
      const result = await createResponse.json();
      console.log('✅ New customer created:', result.customer.id);
      return res.status(200).json({
        success: true,
        message: 'Customer created successfully',
        customer_id: result.customer.id,
        email: result.customer.email,
        existing_customer: false
      });
    } else {
      const createError = await createResponse.text();
      console.error('❌ Customer creation failed:', createResponse.status, createError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create customer',
        details: `Shopify API Error: ${createResponse.status}`
      });
    }

  } catch (error) {
    console.error('❌ Server error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}