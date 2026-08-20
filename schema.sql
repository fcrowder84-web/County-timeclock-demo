-- County TimeClock database schema snapshot
-- Structure only: no employee/timekeeping rows and no secrets are included.
-- Canonical changes remain the numbered SQL migrations; regenerate this file after schema changes.

--
-- PostgreSQL database dump
--

\restrict 7gkf3OSw5xqnrsBkydZTZF5TKq0R3EvL03brpnuy237yoGCobf5xlBTvtZlB0vb

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: validate_time_change_request_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_time_change_request_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  existing_clock_in timestamp;
  existing_clock_out timestamp;
  effective_clock_in timestamp;
  effective_clock_out timestamp;
BEGIN
  SELECT clock_in, clock_out
    INTO existing_clock_in, existing_clock_out
    FROM time_entries
   WHERE id = NEW.time_entry_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original time entry not found or has been deleted'
      USING ERRCODE = '23514';
  END IF;

  effective_clock_in := COALESCE(NEW.requested_clock_in, existing_clock_in);
  effective_clock_out := COALESCE(NEW.requested_clock_out, existing_clock_out);

  IF effective_clock_out IS NOT NULL
     AND effective_clock_out <= effective_clock_in THEN
    RAISE EXCEPTION 'Clock out must be after clock in. Check AM/PM and the date.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: correction_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correction_requests (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    time_entry_id integer,
    request_text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    supervisor_response text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    resolved_at timestamp without time zone
);


--
-- Name: correction_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.correction_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: correction_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.correction_requests_id_seq OWNED BY public.correction_requests.id;


--
-- Name: department_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_heads (
    id bigint NOT NULL,
    department_id integer NOT NULL,
    employee_id integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    assigned_by integer,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: department_heads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.department_heads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: department_heads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.department_heads_id_seq OWNED BY public.department_heads.id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id integer NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    portal_department_id uuid
);


--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id integer NOT NULL,
    employee_number text,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text,
    role text DEFAULT 'employee'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    pin text,
    department text,
    active boolean DEFAULT true NOT NULL,
    department_id integer,
    must_change_pin boolean DEFAULT false NOT NULL,
    portal_user_id uuid,
    portal_department_id uuid,
    portal_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    app_admin_scope text DEFAULT 'own'::text NOT NULL,
    auth_source text DEFAULT 'legacy'::text NOT NULL,
    last_portal_sync_at timestamp with time zone,
    access_removed_at timestamp with time zone,
    directory_sync_state text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT employees_app_admin_scope_check CHECK ((app_admin_scope = ANY (ARRAY['own'::text, 'all'::text])))
);


--
-- Name: employees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employees_id_seq OWNED BY public.employees.id;


--
-- Name: leave_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_entries (
    id bigint NOT NULL,
    employee_id integer NOT NULL,
    leave_date date NOT NULL,
    leave_type text NOT NULL,
    quarter_hours integer NOT NULL,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by_employee_id integer NOT NULL,
    reviewed_by_employee_id integer,
    review_note text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT leave_entries_leave_type_check CHECK ((leave_type = ANY (ARRAY['vacation'::text, 'sick'::text, 'holiday'::text, 'floating_holiday'::text, 'bereavement'::text, 'jury_duty'::text, 'administrative'::text, 'other'::text]))),
    CONSTRAINT leave_entries_quarter_hours_check CHECK (((quarter_hours >= 1) AND (quarter_hours <= 96))),
    CONSTRAINT leave_entries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


--
-- Name: leave_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_entries_id_seq OWNED BY public.leave_entries.id;


--
-- Name: manual_time_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_time_entries (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    added_by_employee_id integer NOT NULL,
    entry_type text NOT NULL,
    entry_date date NOT NULL,
    hours numeric(6,2) NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: manual_time_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.manual_time_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: manual_time_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.manual_time_entries_id_seq OWNED BY public.manual_time_entries.id;


--
-- Name: pay_period_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pay_period_approvals (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    pay_period_start date NOT NULL,
    pay_period_end date NOT NULL,
    employee_signed_at timestamp without time zone,
    supervisor_approved_at timestamp without time zone,
    supervisor_id integer,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    supervisor_employee_id integer,
    payroll_finalized_at timestamp without time zone,
    payroll_finalized_by integer
);


--
-- Name: pay_period_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pay_period_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pay_period_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pay_period_approvals_id_seq OWNED BY public.pay_period_approvals.id;


--
-- Name: portal_directory_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_directory_sync_log (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    received_count integer DEFAULT 0 NOT NULL,
    activated_count integer DEFAULT 0 NOT NULL,
    deactivated_count integer DEFAULT 0 NOT NULL,
    error_message text
);


--
-- Name: portal_directory_sync_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_directory_sync_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_directory_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_directory_sync_log_id_seq OWNED BY public.portal_directory_sync_log.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: supervisor_departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_departments (
    id integer NOT NULL,
    supervisor_employee_id integer NOT NULL,
    department_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: supervisor_departments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supervisor_departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervisor_departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supervisor_departments_id_seq OWNED BY public.supervisor_departments.id;


--
-- Name: supervisor_employee_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_employee_assignments (
    id bigint NOT NULL,
    supervisor_employee_id integer NOT NULL,
    employee_id integer NOT NULL,
    department_id integer NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    assigned_by integer,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT supervisor_employee_assignments_check CHECK ((supervisor_employee_id <> employee_id))
);


--
-- Name: supervisor_employee_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supervisor_employee_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervisor_employee_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supervisor_employee_assignments_id_seq OWNED BY public.supervisor_employee_assignments.id;


--
-- Name: time_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_change_requests (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    time_entry_id integer,
    requested_clock_in timestamp without time zone,
    requested_clock_out timestamp without time zone,
    employee_reason text NOT NULL,
    supervisor_id integer,
    supervisor_note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp without time zone
);


--
-- Name: time_change_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_change_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_change_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_change_requests_id_seq OWNED BY public.time_change_requests.id;


--
-- Name: time_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_entries (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    clock_in timestamp without time zone NOT NULL,
    clock_out timestamp without time zone,
    notes text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_employee_id integer,
    deletion_reason text,
    CONSTRAINT time_entries_clock_order_check CHECK (((deleted_at IS NOT NULL) OR (clock_out IS NULL) OR (clock_out > clock_in)))
);


--
-- Name: COLUMN time_entries.deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.time_entries.deleted_at IS 'Soft-delete timestamp. Normal application queries explicitly exclude rows where deleted_at is not null.';


--
-- Name: COLUMN time_entries.deleted_by_employee_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.time_entries.deleted_by_employee_id IS 'Employee account that soft-deleted this time entry.';


--
-- Name: COLUMN time_entries.deletion_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.time_entries.deletion_reason IS 'Required reason supplied when a punch is soft-deleted.';


--
-- Name: CONSTRAINT time_entries_clock_order_check ON time_entries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT time_entries_clock_order_check ON public.time_entries IS 'Prevents active time entries from having a clock-out equal to or earlier than clock-in.';


--
-- Name: time_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_entries_id_seq OWNED BY public.time_entries.id;


--
-- Name: time_entry_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_entry_audit (
    id integer NOT NULL,
    time_entry_id integer,
    changed_by_employee_id integer,
    old_clock_in timestamp without time zone,
    old_clock_out timestamp without time zone,
    new_clock_in timestamp without time zone,
    new_clock_out timestamp without time zone,
    reason text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE time_entry_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.time_entry_audit IS 'Append-only time-entry change history for the application role.';


--
-- Name: time_entry_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_entry_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_entry_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_entry_audit_id_seq OWNED BY public.time_entry_audit.id;


--
-- Name: time_punch_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_punch_metadata (
    id bigint NOT NULL,
    time_entry_id integer NOT NULL,
    employee_id integer NOT NULL,
    punch_type text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    source_ip inet,
    forwarded_for text,
    latitude double precision,
    longitude double precision,
    accuracy_meters double precision,
    location_status text DEFAULT 'unavailable'::text NOT NULL,
    client_source text DEFAULT 'web'::text NOT NULL,
    CONSTRAINT time_punch_metadata_accuracy CHECK (((accuracy_meters IS NULL) OR (accuracy_meters >= (0)::double precision))),
    CONSTRAINT time_punch_metadata_location_pair CHECK ((((latitude IS NULL) AND (longitude IS NULL)) OR (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision)) AND ((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision))))),
    CONSTRAINT time_punch_metadata_location_status_check CHECK ((location_status = ANY (ARRAY['captured'::text, 'denied'::text, 'unavailable'::text, 'timeout'::text, 'error'::text]))),
    CONSTRAINT time_punch_metadata_punch_type_check CHECK ((punch_type = ANY (ARRAY['clock_in'::text, 'clock_out'::text])))
);


--
-- Name: TABLE time_punch_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.time_punch_metadata IS 'Append-only punch network/GPS metadata for the application role.';


--
-- Name: time_punch_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_punch_metadata_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_punch_metadata_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_punch_metadata_id_seq OWNED BY public.time_punch_metadata.id;


--
-- Name: timeclock_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timeclock_audit_log (
    id bigint NOT NULL,
    actor_employee_id integer,
    action text NOT NULL,
    target_type text,
    target_id text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE timeclock_audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.timeclock_audit_log IS 'Append-only application audit log for the application role.';


--
-- Name: timeclock_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.timeclock_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: timeclock_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.timeclock_audit_log_id_seq OWNED BY public.timeclock_audit_log.id;


--
-- Name: correction_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_requests ALTER COLUMN id SET DEFAULT nextval('public.correction_requests_id_seq'::regclass);


--
-- Name: department_heads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads ALTER COLUMN id SET DEFAULT nextval('public.department_heads_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: employees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees ALTER COLUMN id SET DEFAULT nextval('public.employees_id_seq'::regclass);


--
-- Name: leave_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_entries ALTER COLUMN id SET DEFAULT nextval('public.leave_entries_id_seq'::regclass);


--
-- Name: manual_time_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_time_entries ALTER COLUMN id SET DEFAULT nextval('public.manual_time_entries_id_seq'::regclass);


--
-- Name: pay_period_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals ALTER COLUMN id SET DEFAULT nextval('public.pay_period_approvals_id_seq'::regclass);


--
-- Name: portal_directory_sync_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_directory_sync_log ALTER COLUMN id SET DEFAULT nextval('public.portal_directory_sync_log_id_seq'::regclass);


--
-- Name: supervisor_departments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_departments ALTER COLUMN id SET DEFAULT nextval('public.supervisor_departments_id_seq'::regclass);


--
-- Name: supervisor_employee_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments ALTER COLUMN id SET DEFAULT nextval('public.supervisor_employee_assignments_id_seq'::regclass);


--
-- Name: time_change_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_change_requests ALTER COLUMN id SET DEFAULT nextval('public.time_change_requests_id_seq'::regclass);


--
-- Name: time_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entries ALTER COLUMN id SET DEFAULT nextval('public.time_entries_id_seq'::regclass);


--
-- Name: time_entry_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entry_audit ALTER COLUMN id SET DEFAULT nextval('public.time_entry_audit_id_seq'::regclass);


--
-- Name: time_punch_metadata id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_punch_metadata ALTER COLUMN id SET DEFAULT nextval('public.time_punch_metadata_id_seq'::regclass);


--
-- Name: timeclock_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeclock_audit_log ALTER COLUMN id SET DEFAULT nextval('public.timeclock_audit_log_id_seq'::regclass);


--
-- Name: correction_requests correction_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_requests
    ADD CONSTRAINT correction_requests_pkey PRIMARY KEY (id);


--
-- Name: department_heads department_heads_department_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads
    ADD CONSTRAINT department_heads_department_id_employee_id_key UNIQUE (department_id, employee_id);


--
-- Name: department_heads department_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads
    ADD CONSTRAINT department_heads_pkey PRIMARY KEY (id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: employees employees_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_email_key UNIQUE (email);


--
-- Name: employees employees_employee_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_employee_number_key UNIQUE (employee_number);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: leave_entries leave_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_entries
    ADD CONSTRAINT leave_entries_pkey PRIMARY KEY (id);


--
-- Name: manual_time_entries manual_time_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_time_entries
    ADD CONSTRAINT manual_time_entries_pkey PRIMARY KEY (id);


--
-- Name: pay_period_approvals pay_period_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals
    ADD CONSTRAINT pay_period_approvals_pkey PRIMARY KEY (id);


--
-- Name: portal_directory_sync_log portal_directory_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_directory_sync_log
    ADD CONSTRAINT portal_directory_sync_log_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: supervisor_departments supervisor_departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_departments
    ADD CONSTRAINT supervisor_departments_pkey PRIMARY KEY (id);


--
-- Name: supervisor_departments supervisor_departments_supervisor_employee_id_department_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_departments
    ADD CONSTRAINT supervisor_departments_supervisor_employee_id_department_id_key UNIQUE (supervisor_employee_id, department_id);


--
-- Name: supervisor_employee_assignments supervisor_employee_assignmen_supervisor_employee_id_employ_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignmen_supervisor_employee_id_employ_key UNIQUE (supervisor_employee_id, employee_id);


--
-- Name: supervisor_employee_assignments supervisor_employee_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignments_pkey PRIMARY KEY (id);


--
-- Name: time_change_requests time_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_change_requests
    ADD CONSTRAINT time_change_requests_pkey PRIMARY KEY (id);


--
-- Name: time_entries time_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);


--
-- Name: time_entry_audit time_entry_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entry_audit
    ADD CONSTRAINT time_entry_audit_pkey PRIMARY KEY (id);


--
-- Name: time_punch_metadata time_punch_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_punch_metadata
    ADD CONSTRAINT time_punch_metadata_pkey PRIMARY KEY (id);


--
-- Name: timeclock_audit_log timeclock_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeclock_audit_log
    ADD CONSTRAINT timeclock_audit_log_pkey PRIMARY KEY (id);


--
-- Name: idx_department_heads_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_department_heads_employee ON public.department_heads USING btree (employee_id) WHERE (active = true);


--
-- Name: idx_department_heads_one_active_per_department; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_department_heads_one_active_per_department ON public.department_heads USING btree (department_id) WHERE (active = true);


--
-- Name: idx_departments_portal_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_departments_portal_department_id ON public.departments USING btree (portal_department_id) WHERE (portal_department_id IS NOT NULL);


--
-- Name: idx_employees_active_directory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_active_directory ON public.employees USING btree (active, directory_sync_state);


--
-- Name: idx_employees_portal_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_employees_portal_user_id ON public.employees USING btree (portal_user_id) WHERE (portal_user_id IS NOT NULL);


--
-- Name: idx_leave_one_floating_holiday_per_year; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_leave_one_floating_holiday_per_year ON public.leave_entries USING btree (employee_id, EXTRACT(year FROM leave_date)) WHERE ((leave_type = 'floating_holiday'::text) AND (status = ANY (ARRAY['pending'::text, 'approved'::text])));


--
-- Name: idx_one_primary_supervisor_per_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_one_primary_supervisor_per_employee ON public.supervisor_employee_assignments USING btree (employee_id) WHERE ((active = true) AND (is_primary = true));


--
-- Name: idx_supervisor_assignments_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_assignments_department ON public.supervisor_employee_assignments USING btree (department_id) WHERE (active = true);


--
-- Name: idx_supervisor_assignments_supervisor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_assignments_supervisor ON public.supervisor_employee_assignments USING btree (supervisor_employee_id) WHERE (active = true);


--
-- Name: idx_time_change_requests_pending_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_change_requests_pending_entry ON public.time_change_requests USING btree (time_entry_id, id) WHERE (status = 'pending'::text);


--
-- Name: idx_time_entries_active_employee_clock_in; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_entries_active_employee_clock_in ON public.time_entries USING btree (employee_id, clock_in DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_time_entries_one_active_open_per_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_time_entries_one_active_open_per_employee ON public.time_entries USING btree (employee_id) WHERE ((deleted_at IS NULL) AND (clock_out IS NULL));


--
-- Name: idx_time_punch_metadata_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_punch_metadata_employee ON public.time_punch_metadata USING btree (employee_id, recorded_at DESC);


--
-- Name: idx_time_punch_metadata_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_punch_metadata_entry ON public.time_punch_metadata USING btree (time_entry_id, recorded_at);


--
-- Name: idx_timeclock_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeclock_audit_action ON public.timeclock_audit_log USING btree (action, created_at DESC);


--
-- Name: idx_timeclock_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeclock_audit_actor ON public.timeclock_audit_log USING btree (actor_employee_id, created_at DESC);


--
-- Name: leave_entries_employee_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leave_entries_employee_date_idx ON public.leave_entries USING btree (employee_id, leave_date);


--
-- Name: time_change_requests trg_validate_time_change_request_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_time_change_request_order BEFORE INSERT OR UPDATE OF requested_clock_in, requested_clock_out, time_entry_id ON public.time_change_requests FOR EACH ROW EXECUTE FUNCTION public.validate_time_change_request_order();


--
-- Name: correction_requests correction_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_requests
    ADD CONSTRAINT correction_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: correction_requests correction_requests_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_requests
    ADD CONSTRAINT correction_requests_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id);


--
-- Name: department_heads department_heads_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads
    ADD CONSTRAINT department_heads_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id);


--
-- Name: department_heads department_heads_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads
    ADD CONSTRAINT department_heads_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: department_heads department_heads_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_heads
    ADD CONSTRAINT department_heads_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employees employees_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);


--
-- Name: leave_entries leave_entries_created_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_entries
    ADD CONSTRAINT leave_entries_created_by_employee_id_fkey FOREIGN KEY (created_by_employee_id) REFERENCES public.employees(id);


--
-- Name: leave_entries leave_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_entries
    ADD CONSTRAINT leave_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: leave_entries leave_entries_reviewed_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_entries
    ADD CONSTRAINT leave_entries_reviewed_by_employee_id_fkey FOREIGN KEY (reviewed_by_employee_id) REFERENCES public.employees(id);


--
-- Name: manual_time_entries manual_time_entries_added_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_time_entries
    ADD CONSTRAINT manual_time_entries_added_by_employee_id_fkey FOREIGN KEY (added_by_employee_id) REFERENCES public.employees(id);


--
-- Name: manual_time_entries manual_time_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_time_entries
    ADD CONSTRAINT manual_time_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: pay_period_approvals pay_period_approvals_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals
    ADD CONSTRAINT pay_period_approvals_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: pay_period_approvals pay_period_approvals_payroll_finalized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals
    ADD CONSTRAINT pay_period_approvals_payroll_finalized_by_fkey FOREIGN KEY (payroll_finalized_by) REFERENCES public.employees(id);


--
-- Name: pay_period_approvals pay_period_approvals_supervisor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals
    ADD CONSTRAINT pay_period_approvals_supervisor_employee_id_fkey FOREIGN KEY (supervisor_employee_id) REFERENCES public.employees(id);


--
-- Name: pay_period_approvals pay_period_approvals_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_period_approvals
    ADD CONSTRAINT pay_period_approvals_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.employees(id);


--
-- Name: supervisor_departments supervisor_departments_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_departments
    ADD CONSTRAINT supervisor_departments_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: supervisor_departments supervisor_departments_supervisor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_departments
    ADD CONSTRAINT supervisor_departments_supervisor_employee_id_fkey FOREIGN KEY (supervisor_employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: supervisor_employee_assignments supervisor_employee_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id);


--
-- Name: supervisor_employee_assignments supervisor_employee_assignments_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignments_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: supervisor_employee_assignments supervisor_employee_assignments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: supervisor_employee_assignments supervisor_employee_assignments_supervisor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_employee_assignments
    ADD CONSTRAINT supervisor_employee_assignments_supervisor_employee_id_fkey FOREIGN KEY (supervisor_employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: time_change_requests time_change_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_change_requests
    ADD CONSTRAINT time_change_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: time_change_requests time_change_requests_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_change_requests
    ADD CONSTRAINT time_change_requests_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.employees(id);


--
-- Name: time_change_requests time_change_requests_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_change_requests
    ADD CONSTRAINT time_change_requests_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id);


--
-- Name: time_entries time_entries_deleted_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_deleted_by_employee_id_fkey FOREIGN KEY (deleted_by_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: time_entries time_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: time_entry_audit time_entry_audit_changed_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entry_audit
    ADD CONSTRAINT time_entry_audit_changed_by_employee_id_fkey FOREIGN KEY (changed_by_employee_id) REFERENCES public.employees(id);


--
-- Name: time_entry_audit time_entry_audit_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entry_audit
    ADD CONSTRAINT time_entry_audit_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id);


--
-- Name: time_punch_metadata time_punch_metadata_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_punch_metadata
    ADD CONSTRAINT time_punch_metadata_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: time_punch_metadata time_punch_metadata_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_punch_metadata
    ADD CONSTRAINT time_punch_metadata_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE CASCADE;


--
-- Name: timeclock_audit_log timeclock_audit_log_actor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeclock_audit_log
    ADD CONSTRAINT timeclock_audit_log_actor_employee_id_fkey FOREIGN KEY (actor_employee_id) REFERENCES public.employees(id);


--
-- PostgreSQL database dump complete
--

\unrestrict 7gkf3OSw5xqnrsBkydZTZF5TKq0R3EvL03brpnuy237yoGCobf5xlBTvtZlB0vb
