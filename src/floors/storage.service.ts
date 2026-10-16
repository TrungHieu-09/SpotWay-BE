import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class StorageService {
  private readonly supabase: SupabaseClient | null = null;
  private readonly bucket: string;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'floor-plans';

    if (url && key) {
      this.supabase = createClient(url, key);
    }
  }

  async createSignedUploadUrl(path: string): Promise<{
    signedUrl: string;
    path: string;
    publicUrl: string;
    token: string;
  }> {
    if (!this.supabase) {
      throw new InternalServerErrorException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'Supabase storage is not configured',
      });
    }

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUploadUrl(path);

    if (error || !data) {
      throw new InternalServerErrorException({
        code: 'STORAGE_UPLOAD_URL_ERROR',
        message: error?.message ?? 'Failed to create signed upload URL',
      });
    }

    const { data: publicData } = this.supabase.storage
      .from(this.bucket)
      .getPublicUrl(path);

    return {
      signedUrl: data.signedUrl,
      path: data.path,
      token: data.token,
      publicUrl: publicData.publicUrl,
    };
  }
}
