/**
 * Parcel shipping rate calculator.
 *
 * Prices a shipment from the zone/service rate tables, then adds the
 * surcharges carriers bill on top of transportation: fuel, residential
 * delivery, remote-area delivery, oversize handling and declared-value
 * insurance. Volume discounts apply to the transportation charge only.
 *
 * All money is in US dollars and rounded to whole cents with roundCurrency.
 * Weights are in pounds and dimensions in inches.
 */

export type ServiceLevel = 'ground' | 'two_day' | 'overnight';

export type ShippingZone = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type CountryCode = 'US' | 'CA' | 'MX';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  /** State or province code, e.g. "WA" or "BC". */
  region: string;
  postalCode: string;
  country: CountryCode;
  residential: boolean;
}

export interface PackageDimensions {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface Parcel {
  weightLb: number;
  dimensions: PackageDimensions;
  declaredValueUsd?: number;
}

export interface ShipmentRequest {
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  service: ServiceLevel;
  shipDate: Date;
  /** Weekly on-highway diesel index, US dollars per gallon. */
  fuelIndexUsdPerGallon: number;
  /** Shipments the account sent last calendar month; drives the volume discount. */
  monthlyShipmentCount?: number;
}

export type QuoteLineKind =
  | 'transportation'
  | 'fuel'
  | 'residential'
  | 'remote_area'
  | 'oversize'
  | 'insurance'
  | 'discount';

export interface QuoteLine {
  kind: QuoteLineKind;
  description: string;
  amountUsd: number;
}

export class RateCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateCalculationError';
  }
}

export const SERVICE_LABELS: Record<ServiceLevel, string> = {
  ground: 'Ground',
  two_day: '2-Day Air',
  overnight: 'Next Day Air',
};

/** Charge for the first pound, by service level and zone. */
export const ZONE_BASE_RATES: Record<ServiceLevel, Record<ShippingZone, number>> = {
  ground: { 2: 9.4, 3: 9.95, 4: 10.6, 5: 11.2, 6: 11.9, 7: 12.45, 8: 13.1 },
  two_day: { 2: 18.3, 3: 19.8, 4: 21.4, 5: 23.05, 6: 24.7, 7: 26.2, 8: 28.9 },
  overnight: { 2: 31.6, 3: 34.1, 4: 38.75, 5: 42.3, 6: 45.95, 7: 49.4, 8: 53.6 },
};

/** Charge for each additional started pound, by service level and zone. */
export const ADDITIONAL_POUND_RATES: Record<ServiceLevel, Record<ShippingZone, number>> = {
  ground: { 2: 0.62, 3: 0.71, 4: 0.83, 5: 0.94, 6: 1.08, 7: 1.19, 8: 1.36 },
  two_day: { 2: 1.74, 3: 1.96, 4: 2.31, 5: 2.58, 6: 2.92, 7: 3.2, 8: 3.66 },
  overnight: { 2: 3.12, 3: 3.48, 4: 4.06, 5: 4.52, 6: 4.97, 7: 5.43, 8: 6.1 },
};

/** Business days in transit, by service level and zone. */
const TRANSIT_BUSINESS_DAYS: Record<ServiceLevel, Record<ShippingZone, number>> = {
  ground: { 2: 1, 3: 2, 4: 3, 5: 3, 6: 4, 7: 5, 8: 6 },
  two_day: { 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 3 },
  overnight: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 2 },
};

/**
 * Zones by the distance between the origin and destination 3-digit ZIP
 * prefixes. Anything farther than the last band, and every cross-border
 * shipment, is zone 8.
 */
const ZONE_BANDS: ReadonlyArray<{ maxPrefixDistance: number; zone: ShippingZone }> = [
  { maxPrefixDistance: 5, zone: 2 },
  { maxPrefixDistance: 30, zone: 3 },
  { maxPrefixDistance: 90, zone: 4 },
  { maxPrefixDistance: 180, zone: 5 },
  { maxPrefixDistance: 320, zone: 6 },
  { maxPrefixDistance: 520, zone: 7 },
];

const MAX_PARCELS_PER_SHIPMENT = 20;
const MAX_PARCEL_WEIGHT_LB = 150;
const MINIMUM_BILLABLE_WEIGHT_LB = 1;

/** Cubic inches per pound of dimensional weight. */
const DOMESTIC_DIM_DIVISOR = 139;
const CROSS_BORDER_DIM_DIVISOR = 166;
/** Parcels smaller than this many cubic inches are billed on actual weight. */
const DIM_WEIGHT_MINIMUM_CUBIC_INCHES = 1728;

const FUEL_INDEX_FLOOR_USD = 3.0;
const FUEL_INDEX_STEP_CENTS = 10;
const FUEL_SURCHARGE_FLOOR_PERCENT = 0.0625;
const FUEL_SURCHARGE_STEP_PERCENT = 0.0025;
const FUEL_SURCHARGE_CAP_PERCENT = 0.18;

export const RESIDENTIAL_DELIVERY_FEES: Record<ServiceLevel, number> = {
  ground: 3.9,
  two_day: 4.3,
  overnight: 4.7,
};

/**
 * Postal code prefixes the carriers serve through partner networks or a long
 * linehaul: Puerto Rico and the Virgin Islands, Hawaii and Guam, Alaska,
 * Canada's northern territories and Mexico's peninsulas.
 */
const REMOTE_AREA_POSTAL_PREFIXES: Record<CountryCode, readonly string[]> = {
  US: ['006', '007', '008', '009', '967', '968', '969', '995', '996', '997', '998', '999'],
  CA: ['X0', 'X1', 'Y0', 'Y1'],
  MX: ['22', '23', '77'],
};

export const OVERSIZE_LIMITS = {
  /** Length plus girth above which a parcel needs additional handling. */
  additionalHandlingLengthPlusGirthIn: 105,
  /** Longest side above which a parcel needs additional handling. */
  additionalHandlingLongestSideIn: 48,
  /** Length plus girth above which a parcel is billed as a large package. */
  largePackageLengthPlusGirthIn: 130,
  /** Length plus girth no service accepts. */
  maximumLengthPlusGirthIn: 165,
} as const;

const ADDITIONAL_HANDLING_FEES: Record<ServiceLevel, number> = {
  ground: 21.6,
  two_day: 26.4,
  overnight: 31.2,
};

const LARGE_PACKAGE_FEES: Record<ServiceLevel, number> = {
  ground: 118.0,
  two_day: 142.0,
  overnight: 171.0,
};

const INSURANCE_FREE_COVERAGE_USD = 100;
const INSURANCE_RATE_PER_HUNDRED_USD = 1.15;
const INSURANCE_MINIMUM_CHARGE_USD = 3.6;
const INSURANCE_MAXIMUM_DECLARED_VALUE_USD = 50_000;

/** Checked from the highest tier down; the first tier the account reaches applies. */
export const VOLUME_DISCOUNT_TIERS: ReadonlyArray<{ minimumMonthlyShipments: number; discountPercent: number }> = [
  { minimumMonthlyShipments: 2_000, discountPercent: 0.12 },
  { minimumMonthlyShipments: 500, discountPercent: 0.08 },
  { minimumMonthlyShipments: 100, discountPercent: 0.03 },
];

/** Rounds a dollar amount to whole cents, half away from zero. */
export function roundCurrency(amountUsd: number): number {
  const sign = amountUsd < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(amountUsd) + Number.EPSILON) * 100)) / 100;
}

/** Carriers bill weight in half-pound steps, always rounding up. */
export function roundUpToHalfPound(weightLb: number): number {
  return Math.ceil(weightLb * 2) / 2;
}

export function formatUsd(amountUsd: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountUsd);
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RateCalculationError(`${label} must be a positive number, got ${value}`);
  }
}

function sortedSides(dimensions: PackageDimensions): [number, number, number] {
  const sides = [dimensions.lengthIn, dimensions.widthIn, dimensions.heightIn].sort((a, b) => b - a);
  return [sides[0], sides[1], sides[2]];
}

function zipPrefix(address: Address): number {
  const digits = address.postalCode.replace(/\D/g, '').slice(0, 3);
  if (address.country !== 'US' || digits.length < 3) {
    throw new RateCalculationError(`Cannot derive a ZIP prefix from postal code "${address.postalCode}"`);
  }
  return Number.parseInt(digits, 10);
}

export function isCrossBorder(origin: Address, destination: Address): boolean {
  return origin.country !== destination.country;
}

export function resolveShippingZone(origin: Address, destination: Address): ShippingZone {
  if (isCrossBorder(origin, destination) || origin.country !== 'US') {
    return 8;
  }
  const prefixDistance = Math.abs(zipPrefix(origin) - zipPrefix(destination));
  for (const band of ZONE_BANDS) {
    if (prefixDistance <= band.maxPrefixDistance) {
      return band.zone;
    }
  }
  return 8;
}

export function calculateDimensionalWeight(
  dimensions: PackageDimensions,
  divisor: number = DOMESTIC_DIM_DIVISOR,
): number {
  assertPositiveNumber(dimensions.lengthIn, 'Length');
  assertPositiveNumber(dimensions.widthIn, 'Width');
  assertPositiveNumber(dimensions.heightIn, 'Height');
  const cubicInches = Math.ceil(dimensions.lengthIn) * Math.ceil(dimensions.widthIn) * Math.ceil(dimensions.heightIn);
  return roundUpToHalfPound(cubicInches / divisor);
}

/** The larger of actual and dimensional weight, never below the one-pound minimum. */
export function calculateBillableWeight(parcel: Parcel, crossBorder: boolean): number {
  assertPositiveNumber(parcel.weightLb, 'Parcel weight');
  if (parcel.weightLb > MAX_PARCEL_WEIGHT_LB) {
    throw new RateCalculationError(`Parcels over ${MAX_PARCEL_WEIGHT_LB} lb ship as freight, got ${parcel.weightLb} lb`);
  }
  const actualWeightLb = roundUpToHalfPound(parcel.weightLb);
  const { lengthIn, widthIn, heightIn } = parcel.dimensions;
  if (lengthIn * widthIn * heightIn < DIM_WEIGHT_MINIMUM_CUBIC_INCHES) {
    return Math.max(actualWeightLb, MINIMUM_BILLABLE_WEIGHT_LB);
  }
  const divisor = crossBorder ? CROSS_BORDER_DIM_DIVISOR : DOMESTIC_DIM_DIVISOR;
  const dimensionalWeightLb = calculateDimensionalWeight(parcel.dimensions, divisor);
  return Math.max(actualWeightLb, dimensionalWeightLb, MINIMUM_BILLABLE_WEIGHT_LB);
}

/** Transportation charge for one parcel: the first pound plus every additional started pound. */
export function calculateBaseRate(service: ServiceLevel, zone: ShippingZone, billableWeightLb: number): number {
  assertPositiveNumber(billableWeightLb, 'Billable weight');
  const firstPoundUsd = ZONE_BASE_RATES[service][zone];
  const additionalPounds = Math.max(0, Math.ceil(billableWeightLb) - 1);
  return roundCurrency(firstPoundUsd + additionalPounds * ADDITIONAL_POUND_RATES[service][zone]);
}

/**
 * Fuel surcharge: a floor percentage of the transportation charge while the
 * diesel index is at or below the floor price, plus one step for every ten
 * cents above it, capped. Steps are counted in whole cents so an index such as
 * 3.30 lands on its step instead of just below it.
 */
export function calculateFuelSurcharge(transportationChargeUsd: number, fuelIndexUsdPerGallon: number): number {
  assertPositiveNumber(fuelIndexUsdPerGallon, 'Fuel index');
  const centsAboveFloor = Math.round((fuelIndexUsdPerGallon - FUEL_INDEX_FLOOR_USD) * 100);
  const steps = Math.max(0, Math.floor(centsAboveFloor / FUEL_INDEX_STEP_CENTS));
  const percent = Math.min(FUEL_SURCHARGE_CAP_PERCENT, FUEL_SURCHARGE_FLOOR_PERCENT + steps * FUEL_SURCHARGE_STEP_PERCENT);
  return roundCurrency(transportationChargeUsd * percent);
}

export function calculateResidentialFee(destination: Address, service: ServiceLevel): number {
  return destination.residential ? RESIDENTIAL_DELIVERY_FEES[service] : 0;
}

export function isRemoteAreaPostalCode(postalCode: string, country: CountryCode): boolean {
  const normalized = postalCode.replace(/\s+/g, '').toUpperCase();
  return REMOTE_AREA_POSTAL_PREFIXES[country].some(prefix => normalized.startsWith(prefix));
}

/**
 * Remote-area surcharge for destinations served through a partner network
 * (see REMOTE_AREA_POSTAL_PREFIXES). Applies a percentage of the
 * transportation charge, with a minimum fee.
 */
export function calculateRemoteAreaSurcharge(transportationChargeUsd: number, destination: Address): number {
  if (!isRemoteAreaPostalCode(destination.postalCode, destination.country)) {
    return 0;
  }
  const remoteAreaRate = 0.137;
  const remoteAreaMinimumFeeUsd = 4.85;
  return roundCurrency(Math.max(transportationChargeUsd * remoteAreaRate, remoteAreaMinimumFeeUsd));
}

/**
 * Additional handling or large-package fee for one parcel, from its length
 * plus girth (girth = twice the sum of the two shorter sides).
 */
export function calculateOversizeFee(dimensions: PackageDimensions, service: ServiceLevel): number {
  const [longestIn, middleIn, shortestIn] = sortedSides(dimensions);
  const lengthPlusGirthIn = longestIn + 2 * (middleIn + shortestIn);
  if (lengthPlusGirthIn > OVERSIZE_LIMITS.maximumLengthPlusGirthIn) {
    throw new RateCalculationError(
      `Length plus girth of ${lengthPlusGirthIn} in exceeds the ${OVERSIZE_LIMITS.maximumLengthPlusGirthIn} in maximum`,
    );
  }
  if (lengthPlusGirthIn > OVERSIZE_LIMITS.largePackageLengthPlusGirthIn) {
    return LARGE_PACKAGE_FEES[service];
  }
  if (
    lengthPlusGirthIn > OVERSIZE_LIMITS.additionalHandlingLengthPlusGirthIn ||
    longestIn > OVERSIZE_LIMITS.additionalHandlingLongestSideIn
  ) {
    return ADDITIONAL_HANDLING_FEES[service];
  }
  return 0;
}

/**
 * Declared-value coverage: the first $100 is included, then a fixed price per
 * started $100 of declared value, never below the minimum charge.
 */
export function calculateInsurance(declaredValueUsd: number | undefined): number {
  if (declaredValueUsd === undefined || declaredValueUsd <= INSURANCE_FREE_COVERAGE_USD) {
    return 0;
  }
  if (declaredValueUsd > INSURANCE_MAXIMUM_DECLARED_VALUE_USD) {
    throw new RateCalculationError(
      `Declared value ${formatUsd(declaredValueUsd)} exceeds the ${formatUsd(INSURANCE_MAXIMUM_DECLARED_VALUE_USD)} limit`,
    );
  }
  const billableHundreds = Math.ceil((declaredValueUsd - INSURANCE_FREE_COVERAGE_USD) / 100);
  return roundCurrency(Math.max(billableHundreds * INSURANCE_RATE_PER_HUNDRED_USD, INSURANCE_MINIMUM_CHARGE_USD));
}

/** Discount on the transportation charge only; surcharges are never discounted. */
export function calculateVolumeDiscount(transportationChargeUsd: number, monthlyShipmentCount = 0): number {
  const tier = VOLUME_DISCOUNT_TIERS.find(candidate => monthlyShipmentCount >= candidate.minimumMonthlyShipments);
  return tier ? roundCurrency(transportationChargeUsd * tier.discountPercent) : 0;
}

/** Adds business days to the ship date, skipping Saturdays and Sundays. */
export function estimateDeliveryDate(service: ServiceLevel, zone: ShippingZone, shipDate: Date): Date {
  const delivery = new Date(shipDate.getTime());
  let remainingBusinessDays = TRANSIT_BUSINESS_DAYS[service][zone];
  while (remainingBusinessDays > 0) {
    delivery.setDate(delivery.getDate() + 1);
    const dayOfWeek = delivery.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      remainingBusinessDays -= 1;
    }
  }
  return delivery;
}

export function validateShipmentRequest(request: ShipmentRequest): void {
  if (request.parcels.length === 0) {
    throw new RateCalculationError('A shipment needs at least one parcel');
  }
  if (request.parcels.length > MAX_PARCELS_PER_SHIPMENT) {
    throw new RateCalculationError(
      `A shipment holds at most ${MAX_PARCELS_PER_SHIPMENT} parcels, got ${request.parcels.length}`,
    );
  }
  if (Number.isNaN(request.shipDate.getTime())) {
    throw new RateCalculationError('Ship date is not a valid date');
  }
  if (!(request.service in ZONE_BASE_RATES)) {
    throw new RateCalculationError(`Unknown service level "${request.service}"`);
  }
  assertPositiveNumber(request.fuelIndexUsdPerGallon, 'Fuel index');
}

/** One quote: its lines in the order they were added, and the totals they add up to. */
export class ShippingQuote {
  readonly lines: QuoteLine[] = [];

  constructor(
    readonly service: ServiceLevel,
    readonly zone: ShippingZone,
    readonly billableWeightLb: number,
    readonly estimatedDelivery: Date,
  ) {}

  /** Records a line; zero amounts are skipped so a quote lists only what it bills. */
  addLine(kind: QuoteLineKind, description: string, amountUsd: number): this {
    if (amountUsd === 0) {
      return this;
    }
    this.lines.push({ kind, description, amountUsd: roundCurrency(amountUsd) });
    return this;
  }

  amountFor(kind: QuoteLineKind): number {
    return roundCurrency(
      this.lines.filter(line => line.kind === kind).reduce((total, line) => total + line.amountUsd, 0),
    );
  }

  get subtotalUsd(): number {
    return roundCurrency(
      this.lines.filter(line => line.kind !== 'discount').reduce((total, line) => total + line.amountUsd, 0),
    );
  }

  get discountUsd(): number {
    return -this.amountFor('discount');
  }

  get totalUsd(): number {
    return roundCurrency(this.subtotalUsd - this.discountUsd);
  }

  describe(): string {
    const header = `${SERVICE_LABELS[this.service]}, zone ${this.zone}, ${this.billableWeightLb} lb billable`;
    const lineTexts = this.lines.map(line => `  ${line.description.padEnd(28)} ${formatUsd(line.amountUsd).padStart(12)}`);
    const footer = `  ${'Total'.padEnd(28)} ${formatUsd(this.totalUsd).padStart(12)}`;
    return [header, ...lineTexts, footer].join('\n');
  }

  toJSON(): Record<string, unknown> {
    return {
      service: this.service,
      zone: this.zone,
      billableWeightLb: this.billableWeightLb,
      estimatedDelivery: this.estimatedDelivery.toISOString().slice(0, 10),
      lines: this.lines,
      subtotalUsd: this.subtotalUsd,
      discountUsd: this.discountUsd,
      totalUsd: this.totalUsd,
    };
  }
}

/**
 * Prices a whole shipment. Transportation is billed per parcel and summed;
 * fuel, residential and remote-area surcharges are computed once from that
 * sum; oversize and insurance are per parcel; the volume discount comes last.
 */
export function quoteShipment(request: ShipmentRequest): ShippingQuote {
  validateShipmentRequest(request);
  const zone = resolveShippingZone(request.origin, request.destination);
  const crossBorder = isCrossBorder(request.origin, request.destination);

  const billableWeights = request.parcels.map(parcel => calculateBillableWeight(parcel, crossBorder));
  const totalBillableWeightLb = billableWeights.reduce((total, weight) => total + weight, 0);
  const transportationChargeUsd = roundCurrency(
    billableWeights.reduce((total, weight) => total + calculateBaseRate(request.service, zone, weight), 0),
  );

  const quote = new ShippingQuote(
    request.service,
    zone,
    totalBillableWeightLb,
    estimateDeliveryDate(request.service, zone, request.shipDate),
  );

  quote.addLine('transportation', `${SERVICE_LABELS[request.service]} to zone ${zone}`, transportationChargeUsd);
  quote.addLine(
    'fuel',
    'Fuel surcharge',
    calculateFuelSurcharge(transportationChargeUsd, request.fuelIndexUsdPerGallon),
  );
  quote.addLine('residential', 'Residential delivery', calculateResidentialFee(request.destination, request.service));
  quote.addLine(
    'remote_area',
    'Remote area delivery',
    calculateRemoteAreaSurcharge(transportationChargeUsd, request.destination),
  );

  request.parcels.forEach((parcel, index) => {
    const label = request.parcels.length > 1 ? ` (parcel ${index + 1})` : '';
    quote.addLine('oversize', `Oversize handling${label}`, calculateOversizeFee(parcel.dimensions, request.service));
    quote.addLine('insurance', `Declared value coverage${label}`, calculateInsurance(parcel.declaredValueUsd));
  });

  quote.addLine(
    'discount',
    'Volume discount',
    -calculateVolumeDiscount(transportationChargeUsd, request.monthlyShipmentCount),
  );
  return quote;
}

/** Quotes every service level for the same shipment, cheapest first. */
export function compareServiceLevels(request: Omit<ShipmentRequest, 'service'>): ShippingQuote[] {
  const services: ServiceLevel[] = ['ground', 'two_day', 'overnight'];
  return services
    .map(service => quoteShipment({ ...request, service }))
    .sort((left, right) => left.totalUsd - right.totalUsd);
}

/** The cheapest service level that still delivers by the deadline, or null when none does. */
export function cheapestServiceByDeadline(
  request: Omit<ShipmentRequest, 'service'>,
  deliverBy: Date,
): ShippingQuote | null {
  const onTime = compareServiceLevels(request).filter(quote => quote.estimatedDelivery.getTime() <= deliverBy.getTime());
  return onTime[0] ?? null;
}
