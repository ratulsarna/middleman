import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import type { UpdateManagerInput, UpdateManagerResult } from '@/lib/ws-client'
import type { AgentDescriptor, SlackStatusEvent, TelegramStatusEvent } from '@nexus/protocol'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
  onUpdateManager: (input: UpdateManagerInput) => Promise<UpdateManagerResult>
  onBack?: () => void
}

export function SettingsPanel({
  wsUrl,
  managers,
  slackStatus,
  telegramStatus,
  onUpdateManager,
  onBack,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <SettingsLayout activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack}>
      {activeTab === 'general' && (
        <SettingsGeneral wsUrl={wsUrl} managers={managers} onUpdateManager={onUpdateManager} />
      )}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} />}
      {activeTab === 'integrations' && (
        <SettingsIntegrations
          wsUrl={wsUrl}
          managers={managers}
          slackStatus={slackStatus}
          telegramStatus={telegramStatus}
        />
      )}
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
    </SettingsLayout>
  )
}
