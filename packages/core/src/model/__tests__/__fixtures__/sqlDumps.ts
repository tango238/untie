// SQL 変換 (sqlImport.ts) のテスト用の、現実のダンプに近い入力。会社名・データはすべて架空。

/** pg_dump --schema-only に近い出力 (制約は ALTER TABLE ONLY … ADD CONSTRAINT であとから付く)。データの文も混ぜてある */
export const PG_DUMP = String.raw`--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

\restrict Zk3l9aQ

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET default_tablespace = '';
SET default_table_access_method = heap;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: order_status; Type: TYPE; Schema: public; Owner: bookshop
--

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'paid',
    'shipped',
    'cancelled'
);

ALTER TYPE public.order_status OWNER TO bookshop;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: bookshop
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- ここにある ; や ' は文の切れ目ではない
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.touch_updated_at() OWNER TO bookshop;

SET default_tablespace = '';

--
-- Name: authors; Type: TABLE; Schema: public; Owner: bookshop
--

CREATE TABLE public.authors (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    bio text,
    born_on date
);

ALTER TABLE public.authors OWNER TO bookshop;

COMMENT ON TABLE public.authors IS '著者';

COMMENT ON COLUMN public.authors.name IS '著者名 (筆名を含む)';

CREATE SEQUENCE public.authors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.authors_id_seq OWNED BY public.authors.id;

CREATE TABLE public.publishers (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    country character(2) DEFAULT 'JP'::bpchar NOT NULL
);

ALTER TABLE public.publishers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.publishers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.books (
    id bigint NOT NULL,
    isbn character(13) NOT NULL,
    title character varying(255) NOT NULL,
    publisher_id integer NOT NULL,
    price numeric(8,2) DEFAULT 0 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb,
    published_at timestamp without time zone,
    is_active boolean DEFAULT true NOT NULL,
    cover bytea
);

COMMENT ON COLUMN public.books.isbn IS 'ISBN-13 (ハイフンなし)';

CREATE SEQUENCE public.books_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.books_id_seq OWNED BY public.books.id;

CREATE TABLE public.book_authors (
    book_id bigint NOT NULL,
    author_id integer NOT NULL,
    role character varying(40) DEFAULT 'author'::character varying NOT NULL
);

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    display_name character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.addresses (
    id integer NOT NULL,
    customer_id uuid NOT NULL,
    postal_code character varying(8) NOT NULL,
    line1 text NOT NULL
);

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id uuid NOT NULL,
    status public.order_status DEFAULT 'pending'::public.order_status NOT NULL,
    billing_address_id integer NOT NULL,
    shipping_address_id integer,
    total numeric(10,2) NOT NULL,
    ordered_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.orders IS '注文
(1 注文 1 行。*/ model Injected { は文字としてそのまま残す)';

CREATE TABLE public.order_items (
    order_id bigint NOT NULL,
    line_no integer NOT NULL,
    book_id bigint NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price numeric(8,2) NOT NULL
);

CREATE VIEW public.order_totals AS
 SELECT order_id, sum(quantity) AS qty
   FROM public.order_items
  GROUP BY order_id;

ALTER TABLE ONLY public.authors ALTER COLUMN id SET DEFAULT nextval('public.authors_id_seq'::regclass);

ALTER TABLE ONLY public.books ALTER COLUMN id SET DEFAULT nextval('public.books_id_seq'::regclass);

--
-- Data for Name: authors; Type: TABLE DATA; Schema: public; Owner: bookshop
--

COPY public.authors (id, name, bio, born_on) FROM stdin;
1	山田 花子	略歴; ここの ; は文の切れ目ではない	1970-01-01
2	O'Brien	\N	\N
\.

INSERT INTO public.publishers (name) VALUES ('ほんのむし社; 本店');

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.publishers
    ADD CONSTRAINT publishers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.books
    ADD CONSTRAINT books_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.books
    ADD CONSTRAINT books_isbn_key UNIQUE (isbn);

ALTER TABLE ONLY public.book_authors
    ADD CONSTRAINT book_authors_pkey PRIMARY KEY (book_id, author_id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_id, line_no);

CREATE INDEX idx_books_publisher ON public.books USING btree (publisher_id);

CREATE UNIQUE INDEX idx_addresses_customer_postal ON public.addresses USING btree (customer_id, postal_code);

CREATE TRIGGER trg_books_touch BEFORE UPDATE ON public.books FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE ONLY public.books
    ADD CONSTRAINT books_publisher_id_fkey FOREIGN KEY (publisher_id) REFERENCES public.publishers(id);

ALTER TABLE ONLY public.book_authors
    ADD CONSTRAINT book_authors_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.books(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.book_authors
    ADD CONSTRAINT book_authors_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.authors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_billing_address_id_fkey FOREIGN KEY (billing_address_id) REFERENCES public.addresses(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shipping_address_id_fkey FOREIGN KEY (shipping_address_id) REFERENCES public.addresses(id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.books(id);

GRANT SELECT ON TABLE public.books TO readonly;

\unrestrict Zk3l9aQ

--
-- PostgreSQL database dump complete
--
`;

/** mysqldump --no-data に近い出力 (MySQL / MariaDB)。データ・LOCK TABLES・トリガー (DELIMITER) も混ぜてある */
export const MYSQL_DUMP = String.raw`-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: library
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

--
-- Table structure for table ` + "`members`" + String.raw`
--

DROP TABLE IF EXISTS ` + "`members`" + String.raw`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE ` + "`members`" + String.raw` (
  ` + "`id`" + String.raw` int NOT NULL AUTO_INCREMENT,
  ` + "`name`" + String.raw` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '氏名; 本名',
  ` + "`email`" + String.raw` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  ` + "`joined_on`" + String.raw` date NOT NULL,
  ` + "`is_active`" + String.raw` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (` + "`id`" + String.raw`),
  UNIQUE KEY ` + "`uq_members_email`" + String.raw` (` + "`email`" + String.raw`)
) ENGINE=InnoDB AUTO_INCREMENT=1042 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会員 (it''s a "test")';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table ` + "`members`" + String.raw`
--

LOCK TABLES ` + "`members`" + String.raw` WRITE;
/*!40000 ALTER TABLE ` + "`members`" + String.raw` DISABLE KEYS */;
INSERT INTO ` + "`members`" + String.raw` VALUES (1,'田中; 太郎','taro@example.com','2020-01-01',1),(2,'O\'Brien -- not a comment','ob@example.com','2020-02-01',0);
/*!40000 ALTER TABLE ` + "`members`" + String.raw` ENABLE KEYS */;
UNLOCK TABLES;

DROP TABLE IF EXISTS ` + "`categories`" + String.raw`;
CREATE TABLE ` + "`categories`" + String.raw` (
  ` + "`id`" + String.raw` smallint unsigned NOT NULL AUTO_INCREMENT,
  ` + "`parent_id`" + String.raw` smallint unsigned DEFAULT NULL,
  ` + "`label`" + String.raw` varchar(60) NOT NULL,
  PRIMARY KEY (` + "`id`" + String.raw`),
  KEY ` + "`fk_categories_parent`" + String.raw` (` + "`parent_id`" + String.raw`),
  CONSTRAINT ` + "`fk_categories_parent`" + String.raw` FOREIGN KEY (` + "`parent_id`" + String.raw`) REFERENCES ` + "`categories`" + String.raw` (` + "`id`" + String.raw`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS ` + "`items`" + String.raw`;
CREATE TABLE ` + "`items`" + String.raw` (
  ` + "`id`" + String.raw` bigint unsigned NOT NULL AUTO_INCREMENT,
  ` + "`category_id`" + String.raw` smallint unsigned NOT NULL,
  ` + "`kind`" + String.raw` enum('book','dvd','magazine') NOT NULL DEFAULT 'book',
  ` + "`title`" + String.raw` varchar(255) NOT NULL,
  ` + "`summary`" + String.raw` mediumtext,
  ` + "`price`" + String.raw` decimal(10,2) unsigned NOT NULL DEFAULT '0.00',
  ` + "`is_available`" + String.raw` tinyint(1) NOT NULL DEFAULT '1',
  ` + "`extra`" + String.raw` json DEFAULT NULL,
  ` + "`created_at`" + String.raw` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ` + "`updated_at`" + String.raw` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (` + "`id`" + String.raw`),
  KEY ` + "`idx_items_category`" + String.raw` (` + "`category_id`" + String.raw`),
  FULLTEXT KEY ` + "`ft_items_title`" + String.raw` (` + "`title`" + String.raw`),
  CONSTRAINT ` + "`fk_items_category`" + String.raw` FOREIGN KEY (` + "`category_id`" + String.raw`) REFERENCES ` + "`categories`" + String.raw` (` + "`id`" + String.raw`)
) ENGINE=InnoDB AUTO_INCREMENT=77 DEFAULT CHARSET=utf8mb4 COMMENT='蔵書';

DROP TABLE IF EXISTS ` + "`loans`" + String.raw`;
CREATE TABLE ` + "`loans`" + String.raw` (
  ` + "`id`" + String.raw` int NOT NULL AUTO_INCREMENT,
  ` + "`member_id`" + String.raw` int NOT NULL,
  ` + "`item_id`" + String.raw` bigint unsigned NOT NULL,
  ` + "`loaned_at`" + String.raw` datetime NOT NULL,
  ` + "`returned_at`" + String.raw` datetime DEFAULT NULL,
  PRIMARY KEY (` + "`id`" + String.raw`),
  UNIQUE KEY ` + "`uq_loans_item_at`" + String.raw` (` + "`item_id`" + String.raw`,` + "`loaned_at`" + String.raw`),
  KEY ` + "`fk_loans_member`" + String.raw` (` + "`member_id`" + String.raw`),
  CONSTRAINT ` + "`fk_loans_item`" + String.raw` FOREIGN KEY (` + "`item_id`" + String.raw`) REFERENCES ` + "`items`" + String.raw` (` + "`id`" + String.raw`),
  CONSTRAINT ` + "`fk_loans_member`" + String.raw` FOREIGN KEY (` + "`member_id`" + String.raw`) REFERENCES ` + "`members`" + String.raw` (` + "`id`" + String.raw`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS ` + "`item_tags`" + String.raw`;
CREATE TABLE ` + "`item_tags`" + String.raw` (
  ` + "`item_id`" + String.raw` bigint unsigned NOT NULL,
  ` + "`tag`" + String.raw` varchar(30) NOT NULL,
  PRIMARY KEY (` + "`item_id`" + String.raw`,` + "`tag`" + String.raw`),
  CONSTRAINT ` + "`fk_item_tags_item`" + String.raw` FOREIGN KEY (` + "`item_id`" + String.raw`) REFERENCES ` + "`items`" + String.raw` (` + "`id`" + String.raw`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS ` + "`reservations`" + String.raw`;
CREATE TABLE ` + "`reservations`" + String.raw` (
  ` + "`id`" + String.raw` int NOT NULL AUTO_INCREMENT,
  ` + "`member_id`" + String.raw` int NOT NULL,
  ` + "`item_id`" + String.raw` bigint unsigned NOT NULL,
  ` + "`status`" + String.raw` enum('waiting','ready','expired') NOT NULL DEFAULT 'waiting',
  ` + "`note`" + String.raw` text,
  PRIMARY KEY (` + "`id`" + String.raw`),
  CONSTRAINT ` + "`fk_res_member`" + String.raw` FOREIGN KEY (` + "`member_id`" + String.raw`) REFERENCES ` + "`members`" + String.raw` (` + "`id`" + String.raw`),
  CONSTRAINT ` + "`fk_res_item`" + String.raw` FOREIGN KEY (` + "`item_id`" + String.raw`) REFERENCES ` + "`items`" + String.raw` (` + "`id`" + String.raw`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=` + "`root`@`localhost`" + String.raw`*/ /*!50003 TRIGGER loans_bi BEFORE INSERT ON loans FOR EACH ROW BEGIN
  IF NEW.loaned_at IS NULL THEN
    SET NEW.loaned_at = NOW();
  END IF;
END */;;
DELIMITER ;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;

-- Dump completed on 2024-05-01 12:00:00
`;

/** SQLite の .schema (Laravel のマイグレーションで作ったもの) に近い出力 */
export const SQLITE_SCHEMA = `CREATE TABLE IF NOT EXISTS "migrations" ("id" integer primary key autoincrement not null, "migration" varchar not null, "batch" integer not null);
CREATE TABLE IF NOT EXISTS "projects" ("id" integer primary key autoincrement not null, "name" varchar not null, "description" text, "archived" tinyint(1) not null default '0', "created_at" datetime, "updated_at" datetime);
CREATE UNIQUE INDEX "projects_name_unique" on "projects" ("name");
CREATE TABLE IF NOT EXISTS "users" ("id" integer primary key autoincrement not null, "name" varchar not null, "email" varchar not null, "password" varchar not null, "created_at" datetime);
CREATE UNIQUE INDEX "users_email_unique" on "users" ("email");
CREATE TABLE IF NOT EXISTS "tasks" ("id" integer primary key autoincrement not null, "project_id" integer not null, "assignee_id" integer, "title" varchar not null, "priority" integer not null default '3', "done" tinyint(1) not null default '0', "due_date" date, "estimate" float, "created_at" datetime, foreign key("project_id") references "projects"("id") on delete cascade, foreign key("assignee_id") references "users"("id") on delete set null);
CREATE INDEX "tasks_project_id_index" on "tasks" ("project_id");
CREATE TABLE IF NOT EXISTS "comments" ("id" integer primary key autoincrement not null, "task_id" integer not null, "user_id" integer not null, "body" text not null, "created_at" datetime, foreign key("task_id") references "tasks"("id") on delete cascade, foreign key("user_id") references "users"("id"));
CREATE TABLE IF NOT EXISTS "project_members" ("project_id" integer not null, "user_id" integer not null, "role" varchar check ("role" in ('owner', 'member')) not null default 'member', foreign key("project_id") references "projects"("id") on delete cascade, foreign key("user_id") references "users"("id") on delete cascade, primary key ("project_id", "user_id"));
CREATE TABLE sqlite_sequence(name,seq);
CREATE TRIGGER tasks_touch AFTER UPDATE ON "tasks" BEGIN UPDATE "tasks" SET created_at = created_at WHERE id = NEW.id; INSERT INTO "comments" ("task_id", "user_id", "body") VALUES (NEW.id, 1, 'x; y'); END;
CREATE TABLE "attachments" (id INTEGER PRIMARY KEY, task_id INT REFERENCES tasks(id), file_name TEXT NOT NULL, bytes BLOB, mime VARCHAR(80));
`;

/** 手書きの schema.sql (ANSI に近い。DEFAULT・CHECK・インラインの REFERENCES・列の PRIMARY KEY) */
export const HANDWRITTEN_SCHEMA = `-- 勤怠管理 (架空)
CREATE TABLE departments (
  dept_code CHAR(4) PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  dept_code CHAR(4) NOT NULL REFERENCES departments (dept_code),
  manager_id INTEGER REFERENCES employees(id),
  full_name VARCHAR(100) NOT NULL,
  hired_on DATE DEFAULT CURRENT_DATE,
  salary NUMERIC(12, 2) CHECK (salary >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE time_entries (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes BETWEEN 0 AND 1440),
  memo TEXT,
  PRIMARY KEY (employee_id, work_date)
);
`;

/** SQL Server Management Studio の「スクリプトの生成」に近い出力 (WITH CHECK ADD CONSTRAINT・CLUSTERED・WITH (…) ON [PRIMARY]・GO・DEFAULT … FOR) */
export const SQLSERVER_SCRIPT = `USE [shop]
GO
/****** Object:  Table [dbo].[Customers]    Script Date: 2024/01/15 10:00:00 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Customers](
	[CustomerID] [int] IDENTITY(1,1) NOT NULL,
	[Name] [nvarchar](100) NOT NULL,
	[Email] [nvarchar](200) NULL,
	[Code] [nchar](5) NOT NULL,
 CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED 
(
	[CustomerID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY],
 CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED 
(
	[Email] DESC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Orders]    Script Date: 2024/01/15 10:00:00 ******/
SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Orders](
	[OrderID] [int] IDENTITY(1,1) NOT NULL,
	[CustomerID] [int] NOT NULL,
	[Created] [datetime] NOT NULL,
	[Note] [nvarchar](max) NULL,
 CONSTRAINT [PK_Orders] PRIMARY KEY NONCLUSTERED 
(
	[OrderID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
ALTER TABLE [dbo].[Orders] ADD  CONSTRAINT [DF_Orders_Created]  DEFAULT (getdate()) FOR [Created]
GO
ALTER TABLE [dbo].[Orders]  WITH CHECK ADD  CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerID])
REFERENCES [dbo].[Customers] ([CustomerID])
GO
ALTER TABLE [dbo].[Orders] CHECK CONSTRAINT [FK_Orders_Customers]
GO
`;
