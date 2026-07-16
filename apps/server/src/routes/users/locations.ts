/**
 * User Locations Route
 *
 * GET /:id/locations - Get user's unique locations (aggregated from sessions)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { userIdParamSchema, identityScopeQuerySchema, type UserLocation } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveIdentityScopedServerUserIds, serverUserIdAnyFragment } from './queries.js';

export const locationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/locations - Get user's unique locations (aggregated from sessions)
   *
   * scope=identity expands the result to every account under the same
   * person that the caller can access.
   */
  app.get('/:id/locations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const authUser = request.user;

    const scoped = await resolveIdentityScopedServerUserIds(db, authUser, id, query.data.scope);
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    // Deduplicate to one row per play, then aggregate by location.
    // Each play is assigned to its most recent segment's location.
    const locationResult = await db.execute(sql`
      WITH plays AS (
        SELECT DISTINCT ON (COALESCE(reference_id, id))
          geo_location_name, geo_city, geo_region, geo_country, geo_lat, geo_lon,
          ip_address, started_at
        FROM sessions
        WHERE ${serverUserIdAnyFragment(scoped.ids)}
        ORDER BY COALESCE(reference_id, id), started_at DESC
      )
      SELECT
        geo_location_name AS location_name,
        geo_city AS city,
        geo_region AS region,
        geo_country AS country,
        geo_lat AS lat,
        geo_lon AS lon,
        count(*)::int AS session_count,
        max(started_at) AS last_seen_at,
        array_agg(DISTINCT ip_address) AS ip_addresses
      FROM plays
      GROUP BY geo_location_name, geo_city, geo_region, geo_country, geo_lat, geo_lon
      ORDER BY max(started_at) DESC
    `);

    const locations: UserLocation[] = (
      locationResult.rows as {
        location_name: string | null;
        city: string | null;
        region: string | null;
        country: string | null;
        lat: number | null;
        lon: number | null;
        session_count: number;
        last_seen_at: Date;
        ip_addresses: string[];
      }[]
    ).map((loc) => ({
      locationName: loc.location_name,
      city: loc.city,
      region: loc.region,
      country: loc.country,
      lat: loc.lat,
      lon: loc.lon,
      sessionCount: loc.session_count,
      lastSeenAt: loc.last_seen_at,
      ipAddresses: loc.ip_addresses ?? [],
    }));

    return { data: locations };
  });
};
