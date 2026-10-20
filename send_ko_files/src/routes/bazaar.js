import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const bazaarRouter = Router();

// Map the frontend's Bazaar categories to the `categories` table IDs.
const CATEGORY_MAP = {
  Clothing: 2,
  Shoes: 2,
  Bags: 2,
  Accessories: 2,
  Home: 3,
  Electronics: 4,
  Other: 4,
};

const listingSchema = z.object({
  seller: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  category: z.enum(['Clothing', 'Shoes', 'Bags', 'Accessories', 'Home', 'Electronics', 'Other']),
  price: z.number().positive().max(10_000_000),
  stock: z.number().int().min(1).max(99_999),
  description: z.string().min(1).max(500),
});

bazaarRouter.post('/bazaar-listing', requireAuth, async (req, res, next) => {
  try {
    const parsed = listingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    const { seller, name, category, price, stock, description } = parsed.data;

    // Find or create the merchant for this seller.
    let merchant = await query(
      'select id from merchants where name = $1 limit 1',
      [seller]
    );

    if (merchant.rowCount === 0) {
      merchant = await query(
        `insert into merchants (name, kind, is_active)
         values ($1, 'retail', true)
         returning id`,
        [seller]
      );
    }
    const merchantId = merchant.rows[0].id;

    // Build a unique SKU. Prefix + count-of-existing-SKUs-with-same-prefix.
    const prefix = seller.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BZR';
    const skuRow = await query(
      `select count(*) + 1 as n from products where sku like $1`,
      [`${prefix}-%`]
    );
    const sku = `${prefix}-${String(skuRow.rows[0].n).padStart(3, '0')}`;

    const categoryId = CATEGORY_MAP[category];

    const inserted = await query(
      `insert into products
         (sku, name, category_id, merchant_id, unit, reorder_point, price, is_active)
       values ($1, $2, $3, $4, 'pc', 0, $5, true)
       returning id, sku, name, price, created_at`,
      [sku, name, categoryId, merchantId, price]
    );

    res.status(201).json({
      ...inserted.rows[0],
      seller,
      category,
      stock,
      description,
    });
  } catch (err) {
    next(err);
  }
});