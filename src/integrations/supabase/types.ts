export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_settings: {
        Row: {
          notify_on_control_taken: boolean
          notify_on_device_offline: boolean
          notify_on_session_start: boolean
          payout_address_btc: string | null
          payout_address_eth: string | null
          sweep_to_exchange_enabled: boolean
          telegram_bot_token: string | null
          telegram_chat_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          notify_on_control_taken?: boolean
          notify_on_device_offline?: boolean
          notify_on_session_start?: boolean
          payout_address_btc?: string | null
          payout_address_eth?: string | null
          sweep_to_exchange_enabled?: boolean
          telegram_bot_token?: string | null
          telegram_chat_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          notify_on_control_taken?: boolean
          notify_on_device_offline?: boolean
          notify_on_session_start?: boolean
          payout_address_btc?: string | null
          payout_address_eth?: string | null
          sweep_to_exchange_enabled?: boolean
          telegram_bot_token?: string | null
          telegram_chat_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_wallets: {
        Row: {
          addresses_issued: number
          cdp_wallet_id: string
          chain: string
          coin: string
          created_at: string
          id: string
          updated_at: string
          xpub: string | null
        }
        Insert: {
          addresses_issued?: number
          cdp_wallet_id: string
          chain: string
          coin: string
          created_at?: string
          id?: string
          updated_at?: string
          xpub?: string | null
        }
        Update: {
          addresses_issued?: number
          cdp_wallet_id?: string
          chain?: string
          coin?: string
          created_at?: string
          id?: string
          updated_at?: string
          xpub?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          actor: string | null
          created_at: string
          detail: Json
          device_id: string | null
          event: string
          id: string
          session_id: string | null
        }
        Insert: {
          actor?: string | null
          created_at?: string
          detail?: Json
          device_id?: string | null
          event: string
          id?: string
          session_id?: string | null
        }
        Update: {
          actor?: string | null
          created_at?: string
          detail?: Json
          device_id?: string | null
          event?: string
          id?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_tokens: {
        Row: {
          created_at: string
          name: string
          token: string
        }
        Insert: {
          created_at?: string
          name: string
          token?: string
        }
        Update: {
          created_at?: string
          name?: string
          token?: string
        }
        Relationships: []
      }
      devices: {
        Row: {
          device_id: string
          display_name: string
          enrolled_at: string
          hostname: string | null
          id: string
          is_session_active: boolean
          last_seen_at: string | null
          metadata: Json
          os: string | null
          standing_consent: boolean
          status: string
        }
        Insert: {
          device_id: string
          display_name: string
          enrolled_at?: string
          hostname?: string | null
          id?: string
          is_session_active?: boolean
          last_seen_at?: string | null
          metadata?: Json
          os?: string | null
          standing_consent?: boolean
          status?: string
        }
        Update: {
          device_id?: string
          display_name?: string
          enrolled_at?: string
          hostname?: string | null
          id?: string
          is_session_active?: boolean
          last_seen_at?: string | null
          metadata?: Json
          os?: string | null
          standing_consent?: boolean
          status?: string
        }
        Relationships: []
      }
      license_lookups: {
        Row: {
          created_at: string
          email: string
          id: string
          ip: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          ip?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          ip?: string | null
        }
        Relationships: []
      }
      login_attempts: {
        Row: {
          failures: number
          identifier: string
          last_ip: string | null
          locked_until: string | null
          updated_at: string
        }
        Insert: {
          failures?: number
          identifier: string
          last_ip?: string | null
          locked_until?: string | null
          updated_at?: string
        }
        Update: {
          failures?: number
          identifier?: string
          last_ip?: string | null
          locked_until?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string
          created_at: string
          id: string
          read_at: string | null
          recipient_id: string | null
          sender_id: string | null
          severity: string
          title: string
        }
        Insert: {
          body?: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id?: string | null
          sender_id?: string | null
          severity?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id?: string | null
          sender_id?: string | null
          severity?: string
          title?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          access_link: string | null
          access_link_sent_at: string | null
          amount_coin: number
          amount_usd: number
          coin: string
          company: string | null
          confirmations: number
          created_at: string
          email: string
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          plan_code: string
          price_expires_at: string
          price_locked_at: string
          receive_address: string | null
          status: string
          tx_hash: string | null
          updated_at: string
        }
        Insert: {
          access_link?: string | null
          access_link_sent_at?: string | null
          amount_coin: number
          amount_usd: number
          coin: string
          company?: string | null
          confirmations?: number
          created_at?: string
          email: string
          full_name: string
          id?: string
          notes?: string | null
          phone?: string | null
          plan_code: string
          price_expires_at: string
          price_locked_at?: string
          receive_address?: string | null
          status?: string
          tx_hash?: string | null
          updated_at?: string
        }
        Update: {
          access_link?: string | null
          access_link_sent_at?: string | null
          amount_coin?: number
          amount_usd?: number
          coin?: string
          company?: string | null
          confirmations?: number
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          notes?: string | null
          phone?: string | null
          plan_code?: string
          price_expires_at?: string
          price_locked_at?: string
          receive_address?: string | null
          status?: string
          tx_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_plan_code_fkey"
            columns: ["plan_code"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["code"]
          },
        ]
      }
      payment_events: {
        Row: {
          confirmations: number | null
          created_at: string
          event_type: string
          id: string
          order_id: string
          raw: Json | null
          source: string
          tx_hash: string | null
        }
        Insert: {
          confirmations?: number | null
          created_at?: string
          event_type: string
          id?: string
          order_id: string
          raw?: Json | null
          source: string
          tx_hash?: string | null
        }
        Update: {
          confirmations?: number | null
          created_at?: string
          event_type?: string
          id?: string
          order_id?: string
          raw?: Json | null
          source?: string
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          active: boolean
          amount_usd: number
          code: string
          created_at: string
          description: string | null
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          amount_usd: number
          code: string
          created_at?: string
          description?: string | null
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          amount_usd?: number
          code?: string
          created_at?: string
          description?: string | null
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      power_commands: {
        Row: {
          created_at: string
          delivered_at: string | null
          device_id: string
          dispatched_at: string | null
          error: string | null
          expires_at: string
          id: string
          kind: string
          payload: Json
          relay_device_id: string | null
          requested_by: string | null
          state: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          device_id: string
          dispatched_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          kind: string
          payload?: Json
          relay_device_id?: string | null
          requested_by?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          device_id?: string
          dispatched_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          kind?: string
          payload?: Json
          relay_device_id?: string | null
          requested_by?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "power_commands_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "power_commands_relay_device_id_fkey"
            columns: ["relay_device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      session_cursors: {
        Row: {
          frame_h: number | null
          frame_w: number | null
          kind: string
          session_id: string
          updated_at: string
          visible: boolean
          x: number
          y: number
        }
        Insert: {
          frame_h?: number | null
          frame_w?: number | null
          kind?: string
          session_id: string
          updated_at?: string
          visible?: boolean
          x: number
          y: number
        }
        Update: {
          frame_h?: number | null
          frame_w?: number | null
          kind?: string
          session_id?: string
          updated_at?: string
          visible?: boolean
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "session_cursors_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_frames: {
        Row: {
          frame: string
          height: number | null
          session_id: string
          updated_at: string
          width: number | null
        }
        Insert: {
          frame: string
          height?: number | null
          session_id: string
          updated_at?: string
          width?: number | null
        }
        Update: {
          frame?: string
          height?: number | null
          session_id?: string
          updated_at?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "session_frames_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_inputs: {
        Row: {
          created_at: string
          id: number
          kind: string
          payload: Json
          session_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          kind: string
          payload?: Json
          session_id: string
        }
        Update: {
          created_at?: string
          id?: number
          kind?: string
          payload?: Json
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_inputs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_signals: {
        Row: {
          admin_client_id: string | null
          attempt_id: string | null
          created_at: string
          from_side: string
          id: number
          kind: string
          payload: Json
          session_id: string
        }
        Insert: {
          admin_client_id?: string | null
          attempt_id?: string | null
          created_at?: string
          from_side: string
          id?: number
          kind: string
          payload: Json
          session_id: string
        }
        Update: {
          admin_client_id?: string | null
          attempt_id?: string | null
          created_at?: string
          from_side?: string
          id?: number
          kind?: string
          payload?: Json
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_signals_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_telemetry: {
        Row: {
          admin_client_id: string | null
          created_at: string
          fps: number | null
          frames_decoded: number | null
          frames_dropped: number | null
          frames_presented: number | null
          ice_restarts: number | null
          id: string
          input_path: string | null
          latency_ms: number | null
          peer_state: string | null
          queue_depth: number | null
          render_path: string | null
          session_id: string
          source_height: number | null
          source_width: number | null
          wire_path: string | null
        }
        Insert: {
          admin_client_id?: string | null
          created_at?: string
          fps?: number | null
          frames_decoded?: number | null
          frames_dropped?: number | null
          frames_presented?: number | null
          ice_restarts?: number | null
          id?: string
          input_path?: string | null
          latency_ms?: number | null
          peer_state?: string | null
          queue_depth?: number | null
          render_path?: string | null
          session_id: string
          source_height?: number | null
          source_width?: number | null
          wire_path?: string | null
        }
        Update: {
          admin_client_id?: string | null
          created_at?: string
          fps?: number | null
          frames_decoded?: number | null
          frames_dropped?: number | null
          frames_presented?: number | null
          ice_restarts?: number | null
          id?: string
          input_path?: string | null
          latency_ms?: number | null
          peer_state?: string | null
          queue_depth?: number | null
          render_path?: string | null
          session_id?: string
          source_height?: number | null
          source_width?: number | null
          wire_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_telemetry_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          admin_bound_at: string | null
          admin_client_id: string | null
          consent_at: string | null
          created_at: string
          device_id: string | null
          ended_at: string | null
          id: string
          mode: string
          pairing_code: string | null
          state: string
          technician_id: string | null
          updated_at: string
        }
        Insert: {
          admin_bound_at?: string | null
          admin_client_id?: string | null
          consent_at?: string | null
          created_at?: string
          device_id?: string | null
          ended_at?: string | null
          id?: string
          mode?: string
          pairing_code?: string | null
          state?: string
          technician_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_bound_at?: string | null
          admin_client_id?: string | null
          consent_at?: string | null
          created_at?: string
          device_id?: string | null
          ended_at?: string | null
          id?: string
          mode?: string
          pairing_code?: string | null
          state?: string
          technician_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bind_admin: {
        Args: { _client_id: string; _session_id: string }
        Returns: {
          admin_client_id: string
          bound: boolean
          reason: string
        }[]
      }
      get_paid_order_count: { Args: never; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      prune_session_ephemera: { Args: never; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      app_role: "admin" | "technician" | "super_admin" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "technician", "super_admin", "viewer"],
    },
  },
} as const
