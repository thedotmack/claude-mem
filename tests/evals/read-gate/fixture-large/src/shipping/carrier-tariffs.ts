/**
 * Carrier tariff tables and accessorial surcharges.
 *
 * Each carrier publishes a zone/weight tariff, a fuel surcharge schedule keyed
 * to the weekly diesel index, and its own accessorial charges. quoteCarrierRate
 * at the bottom of the file picks the carrier's functions from CARRIER_PRICING
 * and adds the cross-carrier surcharges (dangerous goods, lithium batteries,
 * dry ice, temperature control) that apply to every carrier alike.
 *
 * All amounts are in USD; weights are in kilograms.
 */

export type CarrierCode = 'NXP' | 'TLX' | 'BRK' | 'SVR' | 'HLM' | 'QSP' | 'ORB';

export type ServiceLevel = 'ground' | 'express' | 'overnight' | 'freight';

export interface TariffRow {
  zone: number;
  minWeightKg: number;
  maxWeightKg: number;
  baseRate: number;
  perKgRate: number;
}

export interface FuelBand {
  minDieselPrice: number;
  maxDieselPrice: number;
  percent: number;
}

export interface ShipmentContext {
  carrier: CarrierCode;
  service: ServiceLevel;
  zone: number;
  weightKg: number;
  declaredValue: number;
  dieselPrice: number;
  residential: boolean;
  signatureRequired: boolean;
  saturdayDelivery: boolean;
  liftgateRequired: boolean;
  lithiumBatteryKg: number;
  dryIceKg: number;
  dangerousGoodsClass: number | null;
  temperatureControlled: boolean;
}

export interface ChargeLine {
  code: string;
  description: string;
  amount: number;
}

export interface CarrierPricing {
  name: string;
  baseCharge: (context: ShipmentContext) => number;
  fuelSurcharge: (context: ShipmentContext, transportation: number) => number;
  accessorials: (context: ShipmentContext) => ChargeLine[];
}

/** Rounds to cents the way every carrier invoice does: half up. */
export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** The tariff row for a zone and weight, or the heaviest band when the weight is above every band. */
export function findTariffRow(table: readonly TariffRow[], zone: number, weightKg: number): TariffRow {
  const zoneRows = table.filter(row => row.zone === zone);
  if (zoneRows.length === 0) {
    throw new Error(`No tariff rows for zone ${zone}`);
  }
  const row = zoneRows.find(candidate => weightKg > candidate.minWeightKg && weightKg <= candidate.maxWeightKg);
  return row ?? zoneRows[zoneRows.length - 1];
}

/** The fuel percentage for a diesel price, from a carrier's weekly schedule. */
export function findFuelPercent(bands: readonly FuelBand[], dieselPrice: number): number {
  const band = bands.find(candidate => dieselPrice >= candidate.minDieselPrice && dieselPrice < candidate.maxDieselPrice);
  if (!band) {
    throw new Error(`Diesel price ${dieselPrice} is outside the fuel schedule`);
  }
  return band.percent;
}

// ---------------------------------------------------------------------------
// Northline Express (NXP)
// ---------------------------------------------------------------------------

export const NORTHLINE_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.36, perKgRate: 0.71 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.05, perKgRate: 0.68 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 20.37, perKgRate: 0.64 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 17.99, perKgRate: 0.66 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 20.48, perKgRate: 0.64 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 31.93, perKgRate: 0.60 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 8.58, perKgRate: 0.63 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 12.68, perKgRate: 0.62 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 14.27, perKgRate: 0.58 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 18.00, perKgRate: 0.57 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 24.00, perKgRate: 0.56 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.21, perKgRate: 0.54 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.92, perKgRate: 0.72 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.70, perKgRate: 0.68 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.40, perKgRate: 0.65 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 28.24, perKgRate: 0.68 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.91, perKgRate: 0.60 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 29.57, perKgRate: 0.65 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.92, perKgRate: 0.63 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.96, perKgRate: 0.60 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.83, perKgRate: 0.61 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 19.78, perKgRate: 0.59 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.94, perKgRate: 0.53 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 26.89, perKgRate: 0.50 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.53, perKgRate: 1.04 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.66, perKgRate: 1.01 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 24.15, perKgRate: 0.98 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 21.14, perKgRate: 0.93 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.68, perKgRate: 0.99 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.46, perKgRate: 0.99 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 13.01, perKgRate: 0.89 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.11, perKgRate: 0.85 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.61, perKgRate: 0.82 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 24.85, perKgRate: 0.80 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.54, perKgRate: 0.77 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 31.79, perKgRate: 0.70 },
];

export const NORTHLINE_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1187 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1283 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1368 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1448 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1550 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1666 },
];

/** Northline Express: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateNorthlineBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(NORTHLINE_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.515);
    case 'overnight':
      return roundToCents(transportation * 2.162);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.932, 100.66));
  }
}

/** Northline Express: weekly fuel percentage applied to the transportation charge. */
export function calculateNorthlineFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(NORTHLINE_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Northline Express: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateNorthlineAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 3.90 : 4.76;
    lines.push({ code: 'NXP-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 6.79 : 5.77;
    lines.push({ code: 'NXP-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Northline Express does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'NXP-SAT', description: 'Saturday delivery', amount: 16.47 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(78.65 + context.weightKg * 0.068);
    lines.push({ code: 'NXP-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 300) {
    const insured = context.declaredValue - 300;
    const amount = Math.max(roundToCents((insured / 100) * 1.078), 3.76);
    lines.push({ code: 'NXP-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tidewater Logistics (TLX)
// ---------------------------------------------------------------------------

export const TIDEWATER_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.44, perKgRate: 0.52 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 12.93, perKgRate: 0.49 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.65, perKgRate: 0.47 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.60, perKgRate: 0.42 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 21.01, perKgRate: 0.37 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 28.94, perKgRate: 0.37 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.38, perKgRate: 0.79 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.57, perKgRate: 0.76 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 20.39, perKgRate: 0.73 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.71, perKgRate: 0.68 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 20.27, perKgRate: 0.63 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 27.90, perKgRate: 0.67 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.11, perKgRate: 0.75 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 12.95, perKgRate: 0.72 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 21.56, perKgRate: 0.70 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 26.68, perKgRate: 0.68 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 25.58, perKgRate: 0.65 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 39.29, perKgRate: 0.66 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.76, perKgRate: 0.64 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 15.90, perKgRate: 0.61 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 20.07, perKgRate: 0.57 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 25.35, perKgRate: 0.57 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 23.48, perKgRate: 0.55 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 35.63, perKgRate: 0.46 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.98, perKgRate: 1.04 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.89, perKgRate: 1.01 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 18.37, perKgRate: 1.01 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.31, perKgRate: 0.94 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 23.91, perKgRate: 0.95 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 24.62, perKgRate: 0.96 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 13.29, perKgRate: 0.79 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 17.33, perKgRate: 0.77 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 22.87, perKgRate: 0.72 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 24.64, perKgRate: 0.68 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 25.98, perKgRate: 0.65 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 33.38, perKgRate: 0.72 },
];

export const TIDEWATER_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1322 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1409 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1521 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1613 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1699 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1785 },
];

/** Tidewater Logistics: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateTidewaterBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(TIDEWATER_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.356);
    case 'overnight':
      return roundToCents(transportation * 1.958);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.821, 134.33));
  }
}

/** Tidewater Logistics: weekly fuel percentage applied to the transportation charge. */
export function calculateTidewaterFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(TIDEWATER_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Tidewater Logistics: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateTidewaterAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 4.61 : 5.34;
    lines.push({ code: 'TLX-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 7.66 : 6.33;
    lines.push({ code: 'TLX-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Tidewater Logistics does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'TLX-SAT', description: 'Saturday delivery', amount: 15.15 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(86.06 + context.weightKg * 0.046);
    lines.push({ code: 'TLX-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 100) {
    const insured = context.declaredValue - 100;
    const amount = Math.max(roundToCents((insured / 100) * 1.318), 3.16);
    lines.push({ code: 'TLX-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Brookfield Parcel (BRK)
// ---------------------------------------------------------------------------

export const BROOKFIELD_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 7.99, perKgRate: 0.57 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.70, perKgRate: 0.54 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 13.62, perKgRate: 0.52 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 18.47, perKgRate: 0.53 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 21.81, perKgRate: 0.44 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 30.52, perKgRate: 0.50 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.16, perKgRate: 0.55 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.79, perKgRate: 0.53 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.61, perKgRate: 0.48 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 26.76, perKgRate: 0.44 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 22.80, perKgRate: 0.41 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 28.42, perKgRate: 0.40 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.53, perKgRate: 0.62 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.22, perKgRate: 0.60 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 15.99, perKgRate: 0.56 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.70, perKgRate: 0.58 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.70, perKgRate: 0.47 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 28.67, perKgRate: 0.57 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.87, perKgRate: 0.83 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 15.63, perKgRate: 0.81 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.21, perKgRate: 0.75 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 24.41, perKgRate: 0.77 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 25.45, perKgRate: 0.71 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.48, perKgRate: 0.73 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 14.25, perKgRate: 0.92 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 19.14, perKgRate: 0.90 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 25.97, perKgRate: 0.89 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 31.84, perKgRate: 0.85 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.57, perKgRate: 0.80 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 41.38, perKgRate: 0.80 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.73, perKgRate: 0.75 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.77, perKgRate: 0.71 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.61, perKgRate: 0.67 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 22.05, perKgRate: 0.65 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 22.39, perKgRate: 0.70 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 30.93, perKgRate: 0.65 },
];

export const BROOKFIELD_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1110 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1216 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1337 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1438 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1545 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1630 },
];

/** Brookfield Parcel: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateBrookfieldBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(BROOKFIELD_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.493);
    case 'overnight':
      return roundToCents(transportation * 1.995);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.944, 91.85));
  }
}

/** Brookfield Parcel: weekly fuel percentage applied to the transportation charge. */
export function calculateBrookfieldFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(BROOKFIELD_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Brookfield Parcel: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateBrookfieldAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 4.25 : 5.08;
    lines.push({ code: 'BRK-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 8.10 : 5.83;
    lines.push({ code: 'BRK-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Brookfield Parcel does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'BRK-SAT', description: 'Saturday delivery', amount: 14.81 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(75.07 + context.weightKg * 0.074);
    lines.push({ code: 'BRK-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 300) {
    const insured = context.declaredValue - 300;
    const amount = Math.max(roundToCents((insured / 100) * 1.258), 4.35);
    lines.push({ code: 'BRK-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Silver Ridge Freight (SVR)
// ---------------------------------------------------------------------------

export const SILVER_RIDGE_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 8.03, perKgRate: 0.58 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.91, perKgRate: 0.56 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 20.01, perKgRate: 0.53 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 16.80, perKgRate: 0.52 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 29.84, perKgRate: 0.51 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 36.88, perKgRate: 0.39 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.42, perKgRate: 0.50 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.27, perKgRate: 0.48 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.39, perKgRate: 0.43 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.33, perKgRate: 0.44 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 25.73, perKgRate: 0.45 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 34.40, perKgRate: 0.42 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.87, perKgRate: 0.64 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.50, perKgRate: 0.61 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.57, perKgRate: 0.57 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 20.33, perKgRate: 0.59 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 33.42, perKgRate: 0.49 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 23.84, perKgRate: 0.47 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.48, perKgRate: 0.85 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.56, perKgRate: 0.81 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.91, perKgRate: 0.79 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.26, perKgRate: 0.80 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 33.22, perKgRate: 0.79 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 31.98, perKgRate: 0.70 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.26, perKgRate: 0.76 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 17.85, perKgRate: 0.74 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.94, perKgRate: 0.68 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.48, perKgRate: 0.70 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 31.66, perKgRate: 0.62 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.10, perKgRate: 0.65 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 14.59, perKgRate: 0.89 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 17.70, perKgRate: 0.87 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 26.31, perKgRate: 0.84 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 26.73, perKgRate: 0.80 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 31.64, perKgRate: 0.77 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 40.59, perKgRate: 0.83 },
];

export const SILVER_RIDGE_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1399 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1474 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1565 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1686 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1804 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1927 },
];

/** Silver Ridge Freight: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateSilverRidgeBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(SILVER_RIDGE_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.508);
    case 'overnight':
      return roundToCents(transportation * 2.153);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.920, 135.79));
  }
}

/** Silver Ridge Freight: weekly fuel percentage applied to the transportation charge. */
export function calculateSilverRidgeFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(SILVER_RIDGE_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Silver Ridge Freight: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateSilverRidgeAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 3.19 : 4.09;
    lines.push({ code: 'SVR-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 7.63 : 6.47;
    lines.push({ code: 'SVR-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Silver Ridge Freight does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'SVR-SAT', description: 'Saturday delivery', amount: 14.83 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(89.15 + context.weightKg * 0.083);
    lines.push({ code: 'SVR-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 100) {
    const insured = context.declaredValue - 100;
    const amount = Math.max(roundToCents((insured / 100) * 1.091), 2.51);
    lines.push({ code: 'SVR-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Cross-carrier special handling
// ---------------------------------------------------------------------------

/** Dangerous goods classes every carrier accepts; class 1 (explosives) and 7 (radioactive) are refused. */
export const ACCEPTED_DANGEROUS_GOODS_CLASSES: readonly number[] = [2, 3, 4, 5, 6, 8, 9];

/**
 * Dangerous goods handling. Ground shipments pay the accessible rate; air
 * services pay the inaccessible rate because the parcel must be loaded where
 * the crew can reach it.
 */
export function calculateDangerousGoodsSurcharge(context: ShipmentContext): number {
  if (context.dangerousGoodsClass === null) return 0;
  if (!ACCEPTED_DANGEROUS_GOODS_CLASSES.includes(context.dangerousGoodsClass)) {
    throw new Error(`Dangerous goods class ${context.dangerousGoodsClass} is not accepted`);
  }
  const accessible = context.service === 'ground' || context.service === 'freight';
  return accessible ? 48.75 : 112.5;
}

/**
 * Lithium battery handling: a per-kilogram charge on the battery weight
 * declared on the shipment, with a minimum per shipment. Batteries packed
 * with equipment ship under the same rate as batteries alone.
 */
export function calculateLithiumBatterySurcharge(context: ShipmentContext): number {
  if (context.lithiumBatteryKg <= 0) return 0;
  const LITHIUM_RATE_PER_KG = 3.15;
  const LITHIUM_MINIMUM_CHARGE = 22.40;
  return roundToCents(Math.max(context.lithiumBatteryKg * LITHIUM_RATE_PER_KG, LITHIUM_MINIMUM_CHARGE));
}

/** Dry ice (UN1845) is billed per kilogram above the first two, which ship free. */
export function calculateDryIceSurcharge(context: ShipmentContext): number {
  const billableKg = Math.max(context.dryIceKg - 2, 0);
  return roundToCents(billableKg * 1.85);
}

/** Temperature-controlled service: a flat fee per shipment plus a share of the transportation charge. */
export function calculateTemperatureControlSurcharge(context: ShipmentContext, transportation: number): number {
  if (!context.temperatureControlled) return 0;
  return roundToCents(35 + transportation * 0.18);
}

// ---------------------------------------------------------------------------
// Hallmark Courier (HLM)
// ---------------------------------------------------------------------------

export const HALLMARK_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 7.82, perKgRate: 0.59 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.75, perKgRate: 0.56 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 13.48, perKgRate: 0.52 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 21.85, perKgRate: 0.50 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 29.42, perKgRate: 0.46 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.39, perKgRate: 0.45 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.66, perKgRate: 0.73 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.63, perKgRate: 0.71 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 18.48, perKgRate: 0.69 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 25.88, perKgRate: 0.65 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 28.71, perKgRate: 0.67 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 34.45, perKgRate: 0.57 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.53, perKgRate: 0.74 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.22, perKgRate: 0.72 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 22.26, perKgRate: 0.69 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.66, perKgRate: 0.63 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 28.23, perKgRate: 0.58 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 31.28, perKgRate: 0.63 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.78, perKgRate: 0.69 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 18.01, perKgRate: 0.68 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 23.82, perKgRate: 0.67 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 29.32, perKgRate: 0.59 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 35.56, perKgRate: 0.58 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 37.02, perKgRate: 0.49 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.07, perKgRate: 0.60 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.40, perKgRate: 0.58 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 20.69, perKgRate: 0.58 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 23.98, perKgRate: 0.56 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 30.95, perKgRate: 0.50 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 26.05, perKgRate: 0.46 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 15.89, perKgRate: 0.74 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 20.95, perKgRate: 0.71 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 27.09, perKgRate: 0.68 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 29.96, perKgRate: 0.62 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 28.00, perKgRate: 0.70 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 43.08, perKgRate: 0.65 },
];

export const HALLMARK_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1191 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1302 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1403 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1502 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1593 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1679 },
];

/** Hallmark Courier: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateHallmarkBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(HALLMARK_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.489);
    case 'overnight':
      return roundToCents(transportation * 2.076);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.913, 109.71));
  }
}

/** Hallmark Courier: weekly fuel percentage applied to the transportation charge. */
export function calculateHallmarkFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(HALLMARK_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Hallmark Courier: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateHallmarkAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 4.02 : 5.01;
    lines.push({ code: 'HLM-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 7.72 : 5.79;
    lines.push({ code: 'HLM-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Hallmark Courier does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'HLM-SAT', description: 'Saturday delivery', amount: 16.56 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(85.35 + context.weightKg * 0.057);
    lines.push({ code: 'HLM-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 500) {
    const insured = context.declaredValue - 500;
    const amount = Math.max(roundToCents((insured / 100) * 1.298), 4.27);
    lines.push({ code: 'HLM-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Quickspan Delivery (QSP)
// ---------------------------------------------------------------------------

export const QUICKSPAN_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.55, perKgRate: 0.66 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 14.75, perKgRate: 0.64 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 15.51, perKgRate: 0.60 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 17.44, perKgRate: 0.61 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 28.41, perKgRate: 0.50 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 32.66, perKgRate: 0.52 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 8.63, perKgRate: 0.61 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.13, perKgRate: 0.59 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.69, perKgRate: 0.55 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 25.27, perKgRate: 0.56 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 19.06, perKgRate: 0.52 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 22.22, perKgRate: 0.49 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 8.83, perKgRate: 0.67 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 12.64, perKgRate: 0.65 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 17.65, perKgRate: 0.63 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 20.38, perKgRate: 0.61 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 21.19, perKgRate: 0.54 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 29.58, perKgRate: 0.60 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.03, perKgRate: 0.88 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.86, perKgRate: 0.85 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.19, perKgRate: 0.86 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 29.99, perKgRate: 0.81 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 26.88, perKgRate: 0.84 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 31.26, perKgRate: 0.80 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 13.48, perKgRate: 0.94 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 17.13, perKgRate: 0.91 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 23.96, perKgRate: 0.87 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 25.93, perKgRate: 0.91 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 37.38, perKgRate: 0.82 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 42.57, perKgRate: 0.79 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.10, perKgRate: 1.01 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 16.57, perKgRate: 0.99 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.34, perKgRate: 0.93 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 18.91, perKgRate: 0.98 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 26.64, perKgRate: 0.91 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 28.37, perKgRate: 0.88 },
];

export const QUICKSPAN_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1104 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1225 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1348 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1467 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1542 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1635 },
];

/** Quickspan Delivery: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateQuickspanBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(QUICKSPAN_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.496);
    case 'overnight':
      return roundToCents(transportation * 2.043);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.912, 137.38));
  }
}

/** Quickspan Delivery: weekly fuel percentage applied to the transportation charge. */
export function calculateQuickspanFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(QUICKSPAN_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Quickspan Delivery: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateQuickspanAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 3.92 : 4.85;
    lines.push({ code: 'QSP-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 8.23 : 6.54;
    lines.push({ code: 'QSP-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Quickspan Delivery does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'QSP-SAT', description: 'Saturday delivery', amount: 16.06 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(81.15 + context.weightKg * 0.048);
    lines.push({ code: 'QSP-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 300) {
    const insured = context.declaredValue - 300;
    const amount = Math.max(roundToCents((insured / 100) * 0.990), 3.71);
    lines.push({ code: 'QSP-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Orbital Shipping (ORB)
// ---------------------------------------------------------------------------

export const ORBITAL_TARIFF: readonly TariffRow[] = [
  { zone: 2, minWeightKg: 0, maxWeightKg: 1, baseRate: 7.88, perKgRate: 0.48 },
  { zone: 2, minWeightKg: 1, maxWeightKg: 5, baseRate: 13.10, perKgRate: 0.46 },
  { zone: 2, minWeightKg: 5, maxWeightKg: 10, baseRate: 16.69, perKgRate: 0.46 },
  { zone: 2, minWeightKg: 10, maxWeightKg: 25, baseRate: 24.18, perKgRate: 0.38 },
  { zone: 2, minWeightKg: 25, maxWeightKg: 50, baseRate: 18.94, perKgRate: 0.38 },
  { zone: 2, minWeightKg: 50, maxWeightKg: 150, baseRate: 30.64, perKgRate: 0.40 },
  { zone: 3, minWeightKg: 0, maxWeightKg: 1, baseRate: 9.80, perKgRate: 0.61 },
  { zone: 3, minWeightKg: 1, maxWeightKg: 5, baseRate: 12.39, perKgRate: 0.59 },
  { zone: 3, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.49, perKgRate: 0.57 },
  { zone: 3, minWeightKg: 10, maxWeightKg: 25, baseRate: 18.80, perKgRate: 0.54 },
  { zone: 3, minWeightKg: 25, maxWeightKg: 50, baseRate: 28.07, perKgRate: 0.50 },
  { zone: 3, minWeightKg: 50, maxWeightKg: 150, baseRate: 34.03, perKgRate: 0.49 },
  { zone: 4, minWeightKg: 0, maxWeightKg: 1, baseRate: 11.28, perKgRate: 0.69 },
  { zone: 4, minWeightKg: 1, maxWeightKg: 5, baseRate: 17.16, perKgRate: 0.65 },
  { zone: 4, minWeightKg: 5, maxWeightKg: 10, baseRate: 21.74, perKgRate: 0.63 },
  { zone: 4, minWeightKg: 10, maxWeightKg: 25, baseRate: 27.29, perKgRate: 0.60 },
  { zone: 4, minWeightKg: 25, maxWeightKg: 50, baseRate: 31.22, perKgRate: 0.54 },
  { zone: 4, minWeightKg: 50, maxWeightKg: 150, baseRate: 38.78, perKgRate: 0.61 },
  { zone: 5, minWeightKg: 0, maxWeightKg: 1, baseRate: 10.49, perKgRate: 0.68 },
  { zone: 5, minWeightKg: 1, maxWeightKg: 5, baseRate: 15.83, perKgRate: 0.65 },
  { zone: 5, minWeightKg: 5, maxWeightKg: 10, baseRate: 19.83, perKgRate: 0.64 },
  { zone: 5, minWeightKg: 10, maxWeightKg: 25, baseRate: 18.80, perKgRate: 0.65 },
  { zone: 5, minWeightKg: 25, maxWeightKg: 50, baseRate: 25.67, perKgRate: 0.57 },
  { zone: 5, minWeightKg: 50, maxWeightKg: 150, baseRate: 27.48, perKgRate: 0.55 },
  { zone: 6, minWeightKg: 0, maxWeightKg: 1, baseRate: 12.19, perKgRate: 0.85 },
  { zone: 6, minWeightKg: 1, maxWeightKg: 5, baseRate: 15.76, perKgRate: 0.82 },
  { zone: 6, minWeightKg: 5, maxWeightKg: 10, baseRate: 22.20, perKgRate: 0.77 },
  { zone: 6, minWeightKg: 10, maxWeightKg: 25, baseRate: 19.77, perKgRate: 0.73 },
  { zone: 6, minWeightKg: 25, maxWeightKg: 50, baseRate: 23.63, perKgRate: 0.72 },
  { zone: 6, minWeightKg: 50, maxWeightKg: 150, baseRate: 40.63, perKgRate: 0.78 },
  { zone: 7, minWeightKg: 0, maxWeightKg: 1, baseRate: 15.38, perKgRate: 0.87 },
  { zone: 7, minWeightKg: 1, maxWeightKg: 5, baseRate: 19.62, perKgRate: 0.85 },
  { zone: 7, minWeightKg: 5, maxWeightKg: 10, baseRate: 22.82, perKgRate: 0.81 },
  { zone: 7, minWeightKg: 10, maxWeightKg: 25, baseRate: 31.82, perKgRate: 0.81 },
  { zone: 7, minWeightKg: 25, maxWeightKg: 50, baseRate: 29.34, perKgRate: 0.81 },
  { zone: 7, minWeightKg: 50, maxWeightKg: 150, baseRate: 30.82, perKgRate: 0.79 },
];

export const ORBITAL_FUEL_SCHEDULE: readonly FuelBand[] = [
  { minDieselPrice: 0.00, maxDieselPrice: 3.00, percent: 0.1344 },
  { minDieselPrice: 3.00, maxDieselPrice: 3.50, percent: 0.1462 },
  { minDieselPrice: 3.50, maxDieselPrice: 4.00, percent: 0.1579 },
  { minDieselPrice: 4.00, maxDieselPrice: 4.50, percent: 0.1659 },
  { minDieselPrice: 4.50, maxDieselPrice: 5.00, percent: 0.1765 },
  { minDieselPrice: 5.00, maxDieselPrice: 99.00, percent: 0.1867 },
];

/** Orbital Shipping: tariff base plus per-kilogram charge, scaled by service level. */
export function calculateOrbitalBaseCharge(context: ShipmentContext): number {
  const row = findTariffRow(ORBITAL_TARIFF, context.zone, context.weightKg);
  const transportation = row.baseRate + row.perKgRate * context.weightKg;
  switch (context.service) {
    case 'ground':
      return roundToCents(transportation);
    case 'express':
      return roundToCents(transportation * 1.464);
    case 'overnight':
      return roundToCents(transportation * 2.039);
    case 'freight':
      return roundToCents(Math.max(transportation * 0.948, 86.31));
  }
}

/** Orbital Shipping: weekly fuel percentage applied to the transportation charge. */
export function calculateOrbitalFuelSurcharge(context: ShipmentContext, transportation: number): number {
  const percent = findFuelPercent(ORBITAL_FUEL_SCHEDULE, context.dieselPrice);
  return roundToCents(transportation * percent);
}

/** Orbital Shipping: accessorial charges the carrier bills on top of transportation and fuel. */
export function calculateOrbitalAccessorials(context: ShipmentContext): ChargeLine[] {
  const lines: ChargeLine[] = [];
  if (context.residential) {
    const amount = context.service === 'ground' ? 3.32 : 4.47;
    lines.push({ code: 'ORB-RES', description: 'Residential delivery', amount });
  }
  if (context.signatureRequired) {
    const amount = context.declaredValue > 1000 ? 7.90 : 6.15;
    lines.push({ code: 'ORB-SIG', description: 'Signature confirmation', amount });
  }
  if (context.saturdayDelivery) {
    if (context.service === 'ground') {
      throw new Error('Orbital Shipping does not deliver ground shipments on Saturday');
    }
    lines.push({ code: 'ORB-SAT', description: 'Saturday delivery', amount: 16.35 });
  }
  if (context.liftgateRequired) {
    const amount = roundToCents(71.46 + context.weightKg * 0.065);
    lines.push({ code: 'ORB-LFT', description: 'Liftgate service', amount });
  }
  if (context.declaredValue > 300) {
    const insured = context.declaredValue - 300;
    const amount = Math.max(roundToCents((insured / 100) * 1.121), 4.16);
    lines.push({ code: 'ORB-DV', description: 'Declared value coverage', amount });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export const CARRIER_PRICING: Record<CarrierCode, CarrierPricing> = {
  NXP: {
    name: 'Northline Express',
    baseCharge: calculateNorthlineBaseCharge,
    fuelSurcharge: calculateNorthlineFuelSurcharge,
    accessorials: calculateNorthlineAccessorials,
  },
  TLX: {
    name: 'Tidewater Logistics',
    baseCharge: calculateTidewaterBaseCharge,
    fuelSurcharge: calculateTidewaterFuelSurcharge,
    accessorials: calculateTidewaterAccessorials,
  },
  BRK: {
    name: 'Brookfield Parcel',
    baseCharge: calculateBrookfieldBaseCharge,
    fuelSurcharge: calculateBrookfieldFuelSurcharge,
    accessorials: calculateBrookfieldAccessorials,
  },
  SVR: {
    name: 'Silver Ridge Freight',
    baseCharge: calculateSilverRidgeBaseCharge,
    fuelSurcharge: calculateSilverRidgeFuelSurcharge,
    accessorials: calculateSilverRidgeAccessorials,
  },
  HLM: {
    name: 'Hallmark Courier',
    baseCharge: calculateHallmarkBaseCharge,
    fuelSurcharge: calculateHallmarkFuelSurcharge,
    accessorials: calculateHallmarkAccessorials,
  },
  QSP: {
    name: 'Quickspan Delivery',
    baseCharge: calculateQuickspanBaseCharge,
    fuelSurcharge: calculateQuickspanFuelSurcharge,
    accessorials: calculateQuickspanAccessorials,
  },
  ORB: {
    name: 'Orbital Shipping',
    baseCharge: calculateOrbitalBaseCharge,
    fuelSurcharge: calculateOrbitalFuelSurcharge,
    accessorials: calculateOrbitalAccessorials,
  },
};

export interface CarrierQuote {
  carrier: CarrierCode;
  carrierName: string;
  lines: ChargeLine[];
  total: number;
}

/** A full quote: transportation, fuel, the carrier's accessorials, then the cross-carrier surcharges. */
export function quoteCarrierRate(context: ShipmentContext): CarrierQuote {
  if (context.weightKg <= 0) {
    throw new Error('Shipment weight must be positive');
  }
  const pricing = CARRIER_PRICING[context.carrier];
  const transportation = pricing.baseCharge(context);
  const lines: ChargeLine[] = [
    { code: 'TRN', description: `${pricing.name} transportation`, amount: transportation },
    { code: 'FSC', description: 'Fuel surcharge', amount: pricing.fuelSurcharge(context, transportation) },
    ...pricing.accessorials(context),
    { code: 'DG', description: 'Dangerous goods handling', amount: calculateDangerousGoodsSurcharge(context) },
    { code: 'LIB', description: 'Lithium battery handling', amount: calculateLithiumBatterySurcharge(context) },
    { code: 'ICE', description: 'Dry ice', amount: calculateDryIceSurcharge(context) },
    { code: 'TMP', description: 'Temperature control', amount: calculateTemperatureControlSurcharge(context, transportation) },
  ].filter(line => line.amount !== 0);
  const total = roundToCents(lines.reduce((sum, line) => sum + line.amount, 0));
  return { carrier: context.carrier, carrierName: pricing.name, lines, total };
}

/** The cheapest carrier for a shipment, skipping carriers that refuse it. */
export function cheapestCarrierQuote(context: Omit<ShipmentContext, 'carrier'>): CarrierQuote {
  const quotes: CarrierQuote[] = [];
  for (const carrier of Object.keys(CARRIER_PRICING) as CarrierCode[]) {
    try {
      quotes.push(quoteCarrierRate({ ...context, carrier }));
    } catch {
      // A carrier that refuses the shipment (Saturday ground, an unknown zone) is not a candidate.
    }
  }
  if (quotes.length === 0) {
    throw new Error('No carrier accepts this shipment');
  }
  return quotes.reduce((best, quote) => (quote.total < best.total ? quote : best));
}
