// Meta Marketing API: product catalog and product set wrapper.

import { compactObject, graphRequest, parseJsonEnv, submitEnabled, withValidateOnly } from './_marketing_api.mjs';

const RESOURCE = (process.env.RESOURCE || 'product_set').toLowerCase();
const ACTION = (process.env.ACTION_KIND || process.env.META_ACTION || 'create').toLowerCase();
const BUSINESS_ID = process.env.BUSINESS_ID || process.env.META_BUSINESS_ID;
const CATALOG_ID = process.env.CATALOG_ID || process.env.PRODUCT_CATALOG_ID;
const PRODUCT_SET_ID = process.env.PRODUCT_SET_ID;

function catalogPayload() {
  return compactObject({
    name: process.env.CATALOG_NAME || process.env.NAME,
    vertical: process.env.CATALOG_VERTICAL || 'commerce',
  });
}

function productSetPayload() {
  return compactObject({
    name: process.env.PRODUCT_SET_NAME || process.env.NAME,
    filter: parseJsonEnv('PRODUCT_SET_FILTER_JSON', process.env.PRODUCT_SET_FILTER ? JSON.parse(process.env.PRODUCT_SET_FILTER) : undefined),
  });
}

try {
  if (RESOURCE === 'catalog') {
    if (ACTION === 'create') {
      if (!BUSINESS_ID) throw new Error('BUSINESS_ID or META_BUSINESS_ID required for catalog create');
      await graphRequest('POST', `/${BUSINESS_ID}/owned_product_catalogs`, withValidateOnly(catalogPayload(), { validateOnly: false }), { label: 'meta-ads-api-catalog' });
    } else if (ACTION === 'read' || ACTION === 'list') {
      const path = CATALOG_ID ? `/${CATALOG_ID}` : `/${BUSINESS_ID}/owned_product_catalogs`;
      await graphRequest('GET', path, { fields: process.env.FIELDS || 'id,name,vertical,product_count', limit: process.env.LIMIT || 50 }, { execute: submitEnabled() || process.env.LIVE_READ === '1', label: 'meta-ads-api-catalog-read' });
    } else if (ACTION === 'update') {
      if (!CATALOG_ID) throw new Error('CATALOG_ID required for catalog update');
      await graphRequest('POST', `/${CATALOG_ID}`, withValidateOnly(catalogPayload(), { validateOnly: false }), { label: 'meta-ads-api-catalog-update' });
    } else {
      throw new Error(`unsupported catalog ACTION=${ACTION}`);
    }
  } else if (RESOURCE === 'product_set') {
    if (ACTION === 'create') {
      if (!CATALOG_ID) throw new Error('CATALOG_ID required for product set create');
      await graphRequest('POST', `/${CATALOG_ID}/product_sets`, withValidateOnly(productSetPayload(), { validateOnly: false }), { label: 'meta-ads-api-product-set' });
    } else if (ACTION === 'read' || ACTION === 'list') {
      const path = PRODUCT_SET_ID ? `/${PRODUCT_SET_ID}` : `/${CATALOG_ID}/product_sets`;
      await graphRequest('GET', path, { fields: process.env.FIELDS || 'id,name,filter', limit: process.env.LIMIT || 50 }, { execute: submitEnabled() || process.env.LIVE_READ === '1', label: 'meta-ads-api-product-set-read' });
    } else if (ACTION === 'update') {
      if (!PRODUCT_SET_ID) throw new Error('PRODUCT_SET_ID required for product set update');
      await graphRequest('POST', `/${PRODUCT_SET_ID}`, withValidateOnly(productSetPayload(), { validateOnly: false }), { label: 'meta-ads-api-product-set-update' });
    } else if (ACTION === 'delete') {
      if (!PRODUCT_SET_ID) throw new Error('PRODUCT_SET_ID required for product set delete');
      await graphRequest('DELETE', `/${PRODUCT_SET_ID}`, {}, { label: 'meta-ads-api-product-set-delete' });
    } else {
      throw new Error(`unsupported product_set ACTION=${ACTION}`);
    }
  } else {
    throw new Error('RESOURCE must be catalog or product_set');
  }
  console.log(`PASS: Meta catalog API ${ACTION} ${RESOURCE} completed`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
