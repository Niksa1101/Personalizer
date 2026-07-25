"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CtaTab } from "@/components/campaigns/cta-tab"
import { GeneralTab } from "@/components/campaigns/general-tab"
import { MergeTab } from "@/components/campaigns/merge-tab"
import { RecorderTab } from "@/components/campaigns/recorder-tab"
import { TemplateEditor } from "@/components/campaigns/template-editor"
import type { CampaignRow, IntroVideoOption } from "@/lib/campaign-types"
import type { SampleLead } from "@/lib/landing-template"

type CampaignSettingsProps = {
  campaign: CampaignRow
  slugLocked: boolean
  intros: IntroVideoOption[]
  hasBuiltVideos: boolean
  sampleLead: SampleLead
}

export function CampaignSettings({
  campaign,
  slugLocked,
  intros,
  hasBuiltVideos,
  sampleLead,
}: CampaignSettingsProps) {
  return (
    <Tabs defaultValue="general" className="w-full gap-6">
      <TabsList className="w-full max-w-3xl">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="merge">Intro &amp; Merge</TabsTrigger>
        <TabsTrigger value="template">Landing Template</TabsTrigger>
        <TabsTrigger value="cta">CTA</TabsTrigger>
        <TabsTrigger value="recorder">Recorder</TabsTrigger>
      </TabsList>

      <TabsContent value="general">
        <GeneralTab campaign={campaign} slugLocked={slugLocked} />
      </TabsContent>

      <TabsContent value="merge">
        <MergeTab
          campaign={campaign}
          intros={intros}
          hasBuiltVideos={hasBuiltVideos}
        />
      </TabsContent>

      <TabsContent value="template" className="max-w-none">
        <TemplateEditor
          campaignId={campaign.id}
          initialTemplate={campaign.landing_template}
          sampleLead={sampleLead}
          ctaType={campaign.cta_type}
          ctaUrl={campaign.cta_url}
          ctaLabel={campaign.cta_label}
        />
      </TabsContent>

      <TabsContent value="cta">
        <CtaTab campaign={campaign} />
      </TabsContent>

      <TabsContent value="recorder">
        <RecorderTab campaign={campaign} />
      </TabsContent>
    </Tabs>
  )
}
