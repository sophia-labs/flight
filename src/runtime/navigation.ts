import {
  AgentNavigationFixSchema,
  type AgentNavigationFix,
  type ContactPercept,
  type GpsCoordinate,
  type NavigationWaypoint,
  type Vec3,
} from "../protocol/schema";
import { basisFromQuat, dot, length, sub } from "../sim/math";
import type { AircraftState } from "../sim/types";

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export const DEFAULT_GPS_ORIGIN: GpsCoordinate = {
  lat: 36.5665,
  lon: -117.9932,
};

const METERS_PER_DEGREE_LAT = 111_320;

// Local-world convention: +X is east and -Z is north. This keeps today's Euclidean sim compatible
// with true-bearing/GPS wording later; a geodetic adapter can populate the same fix shape.
export function compassBearingDeg(vector: { x: number; z: number }): number {
  const degrees = (Math.atan2(vector.x, -vector.z) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

export function compassPoint(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

export function gpsForLocalPosition(position: Vec3, origin: GpsCoordinate = DEFAULT_GPS_ORIGIN): GpsCoordinate {
  const lat = origin.lat + -position.z / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const lon = origin.lon + position.x / Math.max(1, metersPerDegreeLon);
  return {
    lat: roundGps(lat),
    lon: roundGps(lon),
  };
}

export function formatGps(gps: GpsCoordinate): string {
  return `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
}

export function waypointForAircraft(input: {
  id: string;
  label?: string;
  self: AircraftState;
  target: AircraftState;
  origin?: GpsCoordinate;
  note?: string;
}): NavigationWaypoint {
  const relative = sub(input.target.position, input.self.position);
  const bearingDeg = compassBearingDeg(relative);
  return {
    id: input.id,
    ...(input.label ? { label: input.label } : {}),
    gps: gpsForLocalPosition(input.target.position, input.origin),
    altitudeM: input.target.metrics.altitude,
    rangeM: length(relative),
    bearingDeg,
    compass: compassPoint(bearingDeg),
    ...(input.note ? { note: input.note } : {}),
  };
}

export function navigationFixForAgent(
  self: AircraftState,
  world: AircraftState[],
  contacts: ContactPercept[],
  options: { gpsOrigin?: GpsCoordinate; waypoints?: NavigationWaypoint[] } = {},
): AgentNavigationFix {
  const basis = basisFromQuat(self.orientation);
  const headingDeg = compassBearingDeg(basis.forward);
  const contactIds = new Set(contacts.map((contact) => contact.id));
  const visibleContacts = world.filter((candidate) => contactIds.has(candidate.id));

  return AgentNavigationFixSchema.parse({
    self: {
      position: self.position,
      gps: gpsForLocalPosition(self.position, options.gpsOrigin),
      altitudeM: self.metrics.altitude,
      airspeedMps: self.metrics.airspeed,
      headingDeg,
      compass: compassPoint(headingDeg),
    },
    contacts: visibleContacts.map((target) => {
      const relative = sub(target.position, self.position);
      const bearingDeg = compassBearingDeg(relative);
      const rangeM = length(relative);
      return {
        id: target.id,
        gps: gpsForLocalPosition(target.position, options.gpsOrigin),
        rangeM,
        bearingDeg,
        compass: compassPoint(bearingDeg),
        altitudeM: target.metrics.altitude,
        altitudeDeltaM: target.metrics.altitude - self.metrics.altitude,
        closureRateMps: rangeM > 0 ? contacts.find((contact) => contact.id === target.id)?.closureRate : undefined,
        relative: {
          forwardM: dot(relative, basis.forward),
          rightM: dot(relative, basis.right),
          upM: dot(relative, basis.up),
        },
      };
    }),
    ...(options.waypoints?.length ? { waypoints: options.waypoints } : {}),
  });
}

function roundGps(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
