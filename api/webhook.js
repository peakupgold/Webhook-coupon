export default async function handler(req, res) {
  // Set CORS headers to allow requests from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-HTTP-Method-Override, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests for the actual webhook
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Webhook received:', req.body);
    
    const { email, source, discount_code, marketing_consent, tags } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Get Shopify credentials from environment variables
    const shopifyDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    
    if (!shopifyDomain || !accessToken) {
      console.error('Missing Shopify credentials');
      return res.status(500).json({ 
        error: 'Webhook configuration error',
        details: 'Missing Shopify credentials in environment variables'
      });
    }

    // Check if customer already exists
    const searchUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error('Shopify API Error:', searchResponse.status, errorText);
      return res.status(500).json({ 
        error: 'Failed to search for existing customer',
        details: `Shopify API Error: ${searchResponse.status} - ${errorText}`
      });
    }

    const searchData = await searchResponse.json();
    
    // If customer exists, update their marketing consent
    if (searchData.customers && searchData.customers.length > 0) {
      const existingCustomer = searchData.customers[0];
      
      // Update marketing consent
      const updateUrl = `https://${shopifyDomain}/admin/api/2023-10/customers/${existingCustomer.id}.json`;
      const updateData = {
        customer: {
          id: existingCustomer.id,
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          },
          tags: existingCustomer.tags ? `${existingCustomer.tags},${tags}` : tags
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
        return res.status(200).json({
          success: true,
          message: 'Customer already exists - updated marketing consent',
          customer_id: existingCustomer.admin_graphql_api_id,
          note: 'Email was already in system'
        });
      }
    }

    // Create new customer
    const createUrl = `https://${shopifyDomain}/admin/api/2023-10/customers.json`;
    const customerData = {
      customer: {
        email: email,
        email_marketing_consent: {
          state: 'subscribed',
          opt_in_level: 'single_opt_in',
          consent_updated_at: new Date().toISOString()
        },
        tags: tags || 'newsletter,discount-popup',
        note: `Customer created via discount popup. Source: ${source}. Discount code: ${discount_code}. Created: ${new Date().toISOString()}`,
        metafields: [
          {
            namespace: 'discount_popup',
            key: 'source',
            value: source,
            type: 'single_line_text_field'
          },
          {
            namespace: 'discount_popup',
            key: 'discount_code',
            value: discount_code,
            type: 'single_line_text_field'
          }
        ]
      }
    };

    console.log('Creating customer with data:', JSON.stringify(customerData, null, 2));

    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(customerData)
    });

    const responseText = await createResponse.text();
    console.log('Shopify response:', createResponse.status, responseText);

    if (createResponse.ok) {
      const result = JSON.parse(responseText);
      return res.status(200).json({
        success: true,
        message: 'Customer created successfully',
        customer_id: result.customer.admin_graphql_api_id,
        email: result.customer.email
      });
    } else {
      console.error('Failed to create customer:', createResponse.status, responseText);
      return res.status(500).json({ 
        error: 'Failed to create customer',
        details: `Shopify API Error: ${createResponse.status} - ${responseText}`
      });
    }

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}