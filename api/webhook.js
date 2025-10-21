export default async function handler(req, res) {
  // Set comprehensive CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-HTTP-Method-Override, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  
  // Add additional headers to prevent caching and ensure proper response
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    console.log('🔍 Handling OPTIONS preflight request');
    res.status(200).end();
    return;
  }

  // Only allow POST requests for the actual webhook
  if (req.method !== 'POST') {
    console.log('❌ Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed', allowed: 'POST' });
  }

  try {
    console.log('🔍 Webhook request received:', {
      method: req.method,
      url: req.url,
      headers: {
        'content-type': req.headers['content-type'],
        'origin': req.headers['origin'],
        'user-agent': req.headers['user-agent']
      },
      query: req.query,
      bodyType: typeof req.body,
      bodyLength: req.body ? JSON.stringify(req.body).length : 0
    });

    // Enhanced body parsing with better error handling
    let parsedBody;
    try {
      if (typeof req.body === 'string') {
        parsedBody = JSON.parse(req.body);
      } else if (typeof req.body === 'object' && req.body !== null) {
        parsedBody = req.body;
      } else {
        throw new Error('Invalid body type: ' + typeof req.body);
      }
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      console.error('Raw body:', req.body);
      return res.status(400).json({ 
        error: 'Invalid JSON in request body',
        details: parseError.message,
        received: typeof req.body === 'string' ? req.body.substring(0, 200) : String(req.body)
      });
    }

    console.log('✅ Parsed request body:', parsedBody);
    
    const { email, source, discount_code, marketing_consent, tags } = parsedBody;
    
    // Validate required fields
    if (!email) {
      return res.status(400).json({ 
        error: 'Email is required',
        received: parsedBody
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format',
        email: email
      });
    }

    // Get Shopify credentials from environment variables
    const shopifyDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    
    if (!shopifyDomain || !accessToken) {
      console.error('❌ Missing Shopify credentials');
      return res.status(500).json({ 
        error: 'Webhook configuration error',
        details: 'Missing Shopify credentials in environment variables'
      });
    }

    console.log('🔍 Shopify config validated:', {
      domain: shopifyDomain,
      hasToken: !!accessToken,
      tokenLength: accessToken ? accessToken.length : 0
    });

    // Check if customer already exists
    const searchUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`;
    
    console.log('🔍 Searching for existing customer:', searchUrl);
    
    try {
      const searchResponse = await fetch(searchUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        console.error('❌ Shopify API Search Error:', searchResponse.status, errorText);
        return res.status(500).json({ 
          error: 'Failed to search for existing customer',
          details: `Shopify API Error: ${searchResponse.status} - ${errorText}`
        });
      }

      const searchData = await searchResponse.json();
      console.log('🔍 Search results:', searchData);
      
      // If customer exists, update their marketing consent and tags
      if (searchData.customers && searchData.customers.length > 0) {
        const existingCustomer = searchData.customers[0];
        console.log('📝 Updating existing customer:', existingCustomer.id);
        
        // Prepare updated tags
        const existingTags = existingCustomer.tags || '';
        const newTags = tags || 'newsletter,discount-popup,popup-subscriber';
        const combinedTags = existingTags ? `${existingTags},${newTags}` : newTags;
        
        // Update marketing consent and tags
        const updateUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/${existingCustomer.id}.json`;
        const updateData = {
          customer: {
            id: existingCustomer.id,
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString()
            },
            tags: combinedTags
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
          console.log('✅ Existing customer updated successfully');
          return res.status(200).json({
            success: true,
            message: 'Customer already exists - updated marketing consent',
            customer_id: existingCustomer.id,
            email: email,
            existing_customer: true
          });
        } else {
          const updateError = await updateResponse.text();
          console.error('⚠️ Failed to update existing customer:', updateError);
          // Continue to create new customer as fallback
        }
      }

      // Create new customer
      console.log('➕ Creating new customer for:', email);
      const createUrl = `https://${shopifyDomain}/admin/api/2023-10/customers.json`;
      const customerData = {
        customer: {
          email: email,
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          },
          tags: tags || 'newsletter,discount-popup,popup-subscriber',
          note: `Customer created via discount popup. Source: ${source || 'discount_popup'}. Discount code: ${discount_code || 'WELCOME10'}. Created: ${new Date().toISOString()}`,
          metafields: [
            {
              namespace: 'discount_popup',
              key: 'source',
              value: source || 'discount_popup',
              type: 'single_line_text_field'
            },
            {
              namespace: 'discount_popup',
              key: 'discount_code',
              value: discount_code || 'WELCOME10',
              type: 'single_line_text_field'
            },
            {
              namespace: 'discount_popup',
              key: 'created_via',
              value: 'popup_webhook',
              type: 'single_line_text_field'
            }
          ]
        }
      };

      console.log('🔍 Creating customer with data:', JSON.stringify(customerData, null, 2));

      const createResponse = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(customerData)
      });

      const responseText = await createResponse.text();
      console.log('🔍 Shopify create response:', createResponse.status, responseText);

      if (createResponse.ok) {
        const result = JSON.parse(responseText);
        console.log('✅ New customer created successfully:', result.customer.id);
        return res.status(200).json({
          success: true,
          message: 'Customer created successfully',
          customer_id: result.customer.id,
          email: result.customer.email,
          existing_customer: false
        });
      } else {
        console.error('❌ Failed to create customer:', createResponse.status, responseText);
        return res.status(500).json({ 
          error: 'Failed to create customer',
          details: `Shopify API Error: ${createResponse.status} - ${responseText}`
        });
      }

    } catch (shopifyError) {
      console.error('❌ Shopify API Error:', shopifyError);
      return res.status(500).json({ 
        error: 'Shopify API request failed',
        details: shopifyError.message
      });
    }

  } catch (error) {
    console.error('❌ General webhook error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}