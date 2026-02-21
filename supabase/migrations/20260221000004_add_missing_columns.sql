-- Add missing columns referenced by functions
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
