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

  /**
   * Creates a short-lived download URL for an image that was uploaded through
   * this service.  The stored URL is intentionally still the public-shaped
   * object URL, but the analysis worker must also work when the bucket is
   * private.
   */
  async createAnalysisReadUrl(url: string, expiresIn = 20 * 60): Promise<string> {
    if (!this.supabase) return url;

    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return url;
    }

    const prefix = `/storage/v1/object/public/${this.bucket}/`;
    const position = pathname.indexOf(prefix);
    if (position === -1) return url;

    const path = decodeURIComponent(pathname.slice(position + prefix.length));
    if (!path) return url;

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresIn);

    if (error || !data?.signedUrl) {
      throw new InternalServerErrorException({
        code: 'STORAGE_READ_URL_ERROR',
        message: error?.message ?? 'Failed to create a temporary floor-plan read URL',
      });
    }

    return data.signedUrl;
  }
}
