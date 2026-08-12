CREATE TABLE public.qa_cases (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  case_number TEXT NOT NULL,
  designer_name TEXT NOT NULL,
  dealer_name TEXT,
  website_url TEXT,
  date_started DATE,
  case_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.qa_cases TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.qa_cases TO authenticated;
GRANT ALL ON public.qa_cases TO service_role;

ALTER TABLE public.qa_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read qa cases" ON public.qa_cases FOR SELECT USING (true);
CREATE POLICY "Anyone can create qa cases" ON public.qa_cases FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update qa cases" ON public.qa_cases FOR UPDATE USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_qa_cases_updated_at
BEFORE UPDATE ON public.qa_cases
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();