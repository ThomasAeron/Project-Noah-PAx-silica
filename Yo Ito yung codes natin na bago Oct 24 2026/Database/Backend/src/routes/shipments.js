import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';

export const shipmentsRouter = Router();

// ------------------------------------------------------------------
// GET /api/shipments
// Admin-only: list all shipments for the admin dashboard.
// ------------------------------------------------------------------
shipmentsRouter.get(
  '/',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `select
           s.id,
           s.tracking_number,
           s.status,
           s.vehicle_type,
           s.scheduled_at,
           s.dispatched_at,
           s.delivered_at,
           s.created_at,
           a.line1 as destination_line,
           a.area  as destination_area,
           u.full_name as driver_name
         from public.shipments s
         join public.addresses a on a.id = s.destination_addr
         left join public.users u on u.id = s.driver_id
         order by s.created_at desc
         limit 100`
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

// ------------------------------------------------------------------
// POST /api/shipments  — create a shipment via the stored procedure
// ------------------------------------------------------------------
const createSchema = z.object({
  origin_warehouse: z.string().uuid(),
  destination_addr: z.string().uuid(),
  driver_id: z.string().uuid().nullable().optional(),
  vehicle_plate: z.string().max(20).nullable().optional(),
  vehicle_type: z.enum(['motorcycle', 'van', 'truck']).nullable().optional(),
  vehicle_capacity_kg: z.number().int().positive().nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
});

shipmentsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    const b = parsed.data;

    // Generate a unique tracking number: COE-YYYY-XXXXXX
    const year = new Date().getFullYear();
    const seqRow = await query(
      `select count(*) + 1 as n from shipments where tracking_number like $1`,
      [`COE-${year}-%`]
    );
    const tracking = `COE-${year}-${String(seqRow.rows[0].n).padStart(6, '0')}`;

    const result = await query(
      `select public.sp_create_shipment(
         $1::varchar, $2::uuid, $3::uuid, $4::uuid,
         $5::varchar, $6::varchar, $7::integer,
         $8::timestamptz, $9::uuid, $10::jsonb
       ) as shipment_id`,
      [
        tracking,
        b.origin_warehouse,
        b.destination_addr,
        b.driver_id ?? null,
        b.vehicle_plate ?? null,
        b.vehicle_type ?? null,
        b.vehicle_capacity_kg ?? null,
        b.scheduled_at ?? null,
        req.user.id,
        JSON.stringify(b.items),
      ]
    );

    const shipmentId = result.rows[0].shipment_id;

    // Notify the customer who created the shipment.
    await query(
      `insert into public.notifications (user_id, kind, title, body, related_id)
       values ($1, 'order_update', $2, $3, $4)`,
      [
        req.user.id,
        'Order confirmed',
        `Your order ${tracking} has been created and will be dispatched shortly.`,
        shipmentId,
      ]
    );

    res.status(201).json({ id: shipmentId, tracking_number: tracking });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /api/shipments/mine  — shipments created by the current user
// ------------------------------------------------------------------
shipmentsRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `select
         s.id,
         s.tracking_number,
         s.status,
         s.vehicle_type,
         s.scheduled_at,
         s.dispatched_at,
         s.delivered_at,
         s.created_at,
         a.line1                as destination_line,
         a.area                 as destination_area,
         (select count(*) from public.shipment_items si where si.shipment_id = s.id) as line_count,
         (select max(recorded_at) from public.shipment_events se where se.shipment_id = s.id) as last_event_at
       from public.shipments s
       join public.addresses a on a.id = s.destination_addr
       where s.created_by = $1
       order by s.created_at desc
       limit 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /api/shipments/:id  — one shipment with its event timeline
// RBAC: admin/staff/driver see any; customer sees only own
// ------------------------------------------------------------------
shipmentsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `select
         s.id,
         s.tracking_number,
         s.status,
         s.vehicle_plate,
         s.vehicle_type,
         s.vehicle_capacity_kg,
         s.scheduled_at,
         s.dispatched_at,
         s.delivered_at,
         s.created_at,
         s.created_by,
         s.driver_id,
         w.code   as origin_code,
         w.name   as origin_name,
         a.line1  as destination_line,
         a.area   as destination_area,
         a.lat    as destination_lat,
         a.lon    as destination_lon,
         u.full_name as driver_name
       from public.shipments s
       join public.warehouses w on w.id = s.origin_warehouse
       join public.addresses  a on a.id = s.destination_addr
       left join public.users u on u.id = s.driver_id
       where s.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shipment not found' });
    }
    const shipment = rows[0];

    const isPrivileged = req.user.roles.some((r) =>
      ['admin', 'staff', 'driver'].includes(r)
    );
    if (!isPrivileged && shipment.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed to view this shipment' });
    }

    const events = await query(
      `select id, event_type, notes, lat, lon, recorded_at
       from public.shipment_events
       where shipment_id = $1
       order by recorded_at asc`,
      [req.params.id]
    );

    const items = await query(
      `select si.quantity, p.sku, p.name, p.price
       from public.shipment_items si
       join public.products p on p.id = si.product_id
       where si.shipment_id = $1`,
      [req.params.id]
    );

    res.json({
      shipment,
      events: events.rows,
      items: items.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /api/shipments/:id/advance
// Push the shipment to a new status and record an event.
// RBAC: driver / staff / admin only.
// ------------------------------------------------------------------
const advanceSchema = z.object({
  event_type: z.enum([
    'assigned',
    'picked_up',
    'in_transit',
    'delivered',
    'failed',
  ]),
  notes: z.string().max(500).optional(),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
});

const STATUS_AFTER = {
  assigned: 'assigned',
  picked_up: 'in_transit',
  in_transit: 'in_transit',
  delivered: 'delivered',
  failed: 'failed',
};

shipmentsRouter.post(
  '/:id/advance',
  requireAuth,
  async (req, res, next) => {
    try {
      const parsed = advanceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const { event_type, notes, lat, lon } = parsed.data;

      const found = await query(
        `select id, status, created_by from public.shipments where id = $1`,
        [req.params.id]
      );
      if (found.rows.length === 0) {
        return res.status(404).json({ error: 'Shipment not found' });
      }

      // RBAC: privileged roles can advance any shipment.
      // The creator (typically the customer who placed the order) can advance their own.
      const isPrivileged = req.user.roles.some((r) =>
        ['driver', 'staff', 'admin'].includes(r)
      );
      const isCreator = found.rows[0].created_by === req.user.id;
      if (!isPrivileged && !isCreator) {
        return res.status(403).json({
          error: 'Requires one of: driver, staff, admin — or ownership of the shipment',
        });
      }

      const newStatus = STATUS_AFTER[event_type];

      await query(
        `insert into public.shipment_events
           (shipment_id, event_type, notes, lat, lon, recorded_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          req.params.id,
          event_type,
          notes ?? null,
          lat ?? null,
          lon ?? null,
          req.user.id,
        ]
      );

      const updates = ['status = $1'];
      const values = [newStatus];
      if (event_type === 'picked_up') {
        updates.push(`dispatched_at = coalesce(dispatched_at, now())`);
      }
      if (event_type === 'delivered') {
        updates.push(`delivered_at = now()`);
      }
      values.push(req.params.id);

      const updated = await query(
        `update public.shipments
         set ${updates.join(', ')}
         where id = $${values.length}
         returning id, tracking_number, status, dispatched_at, delivered_at`,
        values
      );

      const updatedShipment = updated.rows[0];

      // Notify the shipment's owner about the status change.
      // Skip intermediate in_transit position writes — they would spam the user.
      const messagesByEvent = {
        assigned:   `Driver assigned to ${updatedShipment.tracking_number}.`,
        picked_up:  `Order ${updatedShipment.tracking_number} has been picked up.`,
        delivered:  `Order ${updatedShipment.tracking_number} has been delivered.`,
        failed:     `Order ${updatedShipment.tracking_number} could not be delivered.`,
      };

      if (messagesByEvent[event_type]) {
        await query(
          `insert into public.notifications (user_id, kind, title, body, related_id)
           values ($1, 'order_update', $2, $3, $4)`,
          [
            found.rows[0].created_by,
            event_type === 'delivered' ? 'Delivered' : 'Order update',
            messagesByEvent[event_type],
            updatedShipment.id,
          ]
        );
      }

      res.json({ shipment: updatedShipment });
    } catch (err) {
      next(err);
    }
  }
);