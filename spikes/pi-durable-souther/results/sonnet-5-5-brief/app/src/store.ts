import type { ReservationState, RoomState } from "./model.ts";

export interface Guest { name: string; [k: string]: unknown }
export interface Charge { kind: "追加料金" | "取消料"; description: string; amount: number | null }
export interface Reservation {
  id: string; state: ReservationState; guest: Guest; roomType: string; checkIn: string; checkOut: string;
  channel: string | null; roomId: string | null; charges: Charge[];
}
export interface Room { id: string; type: string; state: RoomState }

export class Store {
  reservations = new Map<string, Reservation>();
  rooms = new Map<string, Room>();
  #n = 0;
  nextId(prefix: string): string { return `${prefix}-${++this.#n}`; }
}
