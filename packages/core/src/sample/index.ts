import type { UntieModel } from "../model/types";
import { createAccountingSample } from "./accounting";
import { createHotelSample } from "./hotel";
import { createNetshopSample } from "./netshop";
import { createRetailSample } from "./retail";

export { accountingSample, createAccountingSample } from "./accounting";
export { hotelSample, createHotelSample } from "./hotel";
export { netshopSample, createNetshopSample } from "./netshop";
export { retailSample, createRetailSample } from "./retail";

/** ホームのサンプルの一覧に並べる 1 件 (将来のサンプルギャラリーの元) */
export interface SampleEntry {
  id: string;
  /** 一覧に出す題名 */
  title: string;
  /** 題名の下に出す一行の紹介 */
  description: string;
  /** 開くたびに新しいモデルを作る (開いたあとの編集がサンプルの元に残らないように) */
  create: () => UntieModel;
}

export const SAMPLES: readonly SampleEntry[] = [
  {
    id: "hotel",
    title: "宿泊施設の業務",
    description: "架空の宿泊施設の、予約からチェックイン・客室対応・精算・清掃までの業務と、現場の困りごと",
    create: createHotelSample,
  },
  {
    id: "netshop",
    title: "ネットショップの業務",
    description: "架空の雑貨のネットショップの、入荷・受注・出荷・返品・問い合わせ対応までの業務と、現場の困りごと",
    create: createNetshopSample,
  },
  {
    id: "retail",
    title: "店舗の業務",
    description: "架空の日用品店の、発注・陳列・レジ・レジ締め・棚卸までの業務と、現場の困りごと",
    create: createRetailSample,
  },
  {
    id: "accounting",
    title: "経理業務",
    description: "架空の中小企業の経理部門の、請求・入金・支払・経費精算・記帳・月次決算・年次決算までの業務と、現場の困りごと",
    create: createAccountingSample,
  },
];
