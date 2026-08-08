export interface Event {
  id: string
  org_id: string
  slug: string
  name: string
  theme: string | null
  timezone: string
  location: string | null
  starts_on: string
  ends_on: string
  airtable_record_id: string | null
  created_at: string
  updated_at: string
}
