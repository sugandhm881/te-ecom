-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS sku_master (
    seller_sku   TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    master_sku   TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Master SKUs (canonical product codes) ────────────────────────────────────
INSERT INTO sku_master (seller_sku, product_name, master_sku) VALUES
  ('TE-UBCSS',  'Ultimate Brightening Combo',          'TE-UBCSS'),
  ('TE-NBS1',   'Brightening Sunscreen',               'TE-NBS1'),
  ('TE-NBS2',   'Brightening Sunscreen (Pack of 2)',   'TE-NBS2'),
  ('TE-10NBS1', '10% Niacinamide Serum',               'TE-10NBS1'),
  ('TE-10NBS2', '10% Niacinamide Serum (Pack of 2)',   'TE-10NBS2'),
  ('TE-CBS',    'Clear & Bright Skin Combo',           'TE-CBS'),
  ('TE-2SAS1',  'Acne Relief Serum',                   'TE-2SAS1'),
  ('TE-2SAS2',  'Acne Relief Serum (Pack of 2)',       'TE-2SAS2'),
  ('TE-LB1',    'Lip Treatment Balm',                  'TE-LB1'),
  ('TE-LB2',    'Lip Treatment Balm (Pack of 2)',      'TE-LB2'),
  ('TE-SDNBS',  'Complete Brightening Solution Combo', 'TE-SDNBS'),
  ('TE-BDR1',   'Brightening Drops - 15 Days',         'TE-BDR1'),
  ('TE-BDR2',   'Brightening Drops - 1 Month',         'TE-BDR2'),
  ('TE-BDR3',   'Brightening Drops - 3 Month',         'TE-BDR3'),
  ('TE-BB1',    'Brightening Bodywash',                'TE-BB1'),
  ('TE-BB2',    'Brightening Bodywash (Pack of 2)',    'TE-BB2'),
  ('TE-FM1',    'Hydrating Face Moisturiser',          'TE-FM1'),
  ('TE-FM2',    'Hydrating Face Moisturiser (Pack 2)', 'TE-FM2'),
  ('TE-BFW1',   'Brightening Face Wash',               'TE-BFW1'),
  ('TE-CSSC',   'Clear & Soft Skin Combo',             'TE-CSSC'),
  ('TE-UCSC',   'Ultimate Clear Skin Combo',           'TE-UCSC'),
  ('TE-BSSC',   'Bright & Soft Skin Combo',            'TE-BSSC'),
  ('TE-DSRC',   'Dry Skin Rescue Combo',               'TE-DSRC'),
  ('TE-2HA1',   'Hydrating Serum (HA + Caffeine)',     'TE-2HA1'),
  ('TE-2HA2',   'Hydrating Serum (Pack of 2)',         'TE-2HA2'),
  ('TE-HBK',    'Holistic Brightening Kit',            'TE-HBK'),
  ('TE-SRD',    'Sun-Protection Duo',                  'TE-SRD'),
  ('TE-HBL1',   'Hydrating Body Lotion',               'TE-HBL1'),
  ('TE-HBL2',   'Hydrating Body Lotion (Pack of 2)',   'TE-HBL2'),
  ('TE-HTHC-1', 'HeadtoToe Hydration Combo',           'TE-HTHC-1'),
  ('TE-BGHD-1', 'Body Glow & Hydration Duo',           'TE-BGHD-1'),
  ('TE-UARO',   'Ultimate Acne Relief Offer',          'TE-UARO')

ON CONFLICT (seller_sku) DO UPDATE
  SET product_name = EXCLUDED.product_name,
      master_sku   = EXCLUDED.master_sku;

-- ── Amazon Marketplace SKU → Master SKU mappings ─────────────────────────────
INSERT INTO sku_master (seller_sku, product_name, master_sku) VALUES
  ('S7-EQ0J-9S4C',     'Brightening Sunscreen',               'TE-NBS1'),
  ('S7-EQ0J-9S4C-PO2', 'Brightening Sunscreen (Pack of 2)',   'TE-NBS2'),
  ('TE-NBS1-FBA',      'Brightening Sunscreen',               'TE-NBS1'),
  ('X3-Z7YA-42X2',     '10% Niacinamide Serum',               'TE-10NBS1'),
  ('TE-10NBS1-FBA',    '10% Niacinamide Serum',               'TE-10NBS1'),
  ('L7-1F0V-U49X',     '10% Niacinamide Serum (Pack of 2)',   'TE-10NBS2'),
  ('ZC-ZK5O-LV28',     'Acne Relief Serum',                   'TE-2SAS1'),
  ('TE-2SAS1-FBA',     'Acne Relief Serum',                   'TE-2SAS1'),
  ('5R-H47M-2XAC',     'Acne Relief Serum (Pack of 2)',       'TE-2SAS2'),
  ('1I-K57X-0BWL',     'Lip Treatment Balm',                  'TE-LB1'),
  ('2F-CP4O-CMAD-R',   'Brightening Drops - 15 Days',         'TE-BDR1'),
  ('8Z-0BZX-C62I',     'Brightening Drops - 15 Days',         'TE-BDR1'),
  ('3I-O1FM-B0U0',     'Brightening Drops - 1 Month',         'TE-BDR2'),
  ('GM-IL6Y-PWW9',     'Brightening Drops - 3 Month',         'TE-BDR3'),
  ('LZ-K6UI-O5D0',     'Brightening Drops - 3 Month',         'TE-BDR3'),
  ('2W-EVVZ-KJNU',     'Brightening Bodywash',                'TE-BB1'),
  ('TE-BB2',           'Brightening Bodywash (Pack of 2)',    'TE-BB2'),
  ('3B-4IJQ-9GS4',     'Hydrating Face Moisturiser',          'TE-FM1'),
  ('TE-FM2',           'Hydrating Face Moisturiser (Pack 2)', 'TE-FM2'),
  ('1Q-9LGM-WIOH',     'Brightening Face Wash',               'TE-BFW1'),
  ('MA-T1KA-0KUP',     'Hydrating Body Lotion',               'TE-HBL1'),
  ('HA2',              'Hydrating Serum (HA + Caffeine)',     'TE-2HA1'),
  ('TE-2HA1-FBA',      'Hydrating Serum (HA + Caffeine)',     'TE-2HA1'),
  ('2E-61O8-5SFE',     'Ultimate Acne Relief Offer',          'TE-UARO')

ON CONFLICT (seller_sku) DO UPDATE
  SET product_name = EXCLUDED.product_name,
      master_sku   = EXCLUDED.master_sku;

-- ── Unmapped (no master SKU provided) ────────────────────────────────────────
-- 2F-CP4O-CMAD  → master unknown, skip for now
-- NC-D17E-5ZB0  → master unknown, skip for now
-- Update these once you know which product they map to:
-- INSERT INTO sku_master VALUES ('2F-CP4O-CMAD', 'Product Name Here', 'TE-XXXX');
-- INSERT INTO sku_master VALUES ('NC-D17E-5ZB0', 'Product Name Here', 'TE-XXXX');
