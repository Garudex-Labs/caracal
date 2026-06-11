/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Content collection schema definitions for the docs site.
 */

import { defineCollection, z } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        hero: z
          .object({
            eyebrow: z.string().optional(),
          })
          .passthrough()
          .optional(),
        pageType: z
          .enum(['concept', 'api', 'workflow', 'config', 'architecture', 'reference', 'landing'])
          .optional(),
        concepts: z.array(z.string()).optional(),
        relatedConcepts: z.array(z.string()).optional(),
        requires: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional(),
        post: z
          .object({
            category: z.string(),
            author: z.string(),
            role: z.string().optional(),
            date: z.coerce.date(),
            readingTime: z.string().optional(),
            tags: z.array(z.string()).optional(),
            featured: z.boolean().optional(),
          })
          .optional(),
        service: z
          .enum(['sts', 'gateway', 'coordinator', 'audit', 'all', 'sdk'])
          .optional(),
      }),
    }),
  }),
}
