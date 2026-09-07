"use client";

import { useState, type ReactNode } from "react";
import styles from "./admin.module.css";
import AdminProductSelector from "./admin-product-selector";

type AdminTab = "operations" | "analytics";
type StatisticsPeriod = "week" | "month" | "year" | "all";

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: "operations", label: "Commandes" },
  { id: "analytics", label: "Statistiques" },
];

const statisticsPeriods: Array<{ id: StatisticsPeriod; label: string }> = [
  { id: "week", label: "Semaine" },
  { id: "month", label: "Mois" },
  { id: "year", label: "Année" },
  { id: "all", label: "Depuis toujours" },
];

export default function AdminTabs({
  operations,
  analytics,
}: {
  operations: ReactNode;
  analytics: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<AdminTab>("operations");
  const [statisticsPeriod, setStatisticsPeriod] = useState<StatisticsPeriod>("all");

  return (
    <div className={styles.tabs}>
      <div className={styles.tabList} role="tablist" aria-label="Sections admin">
        {tabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`admin-tab-${tab.id}`}
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`admin-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <section
        id="admin-panel-operations"
        role="tabpanel"
        aria-labelledby="admin-tab-operations"
        hidden={activeTab !== "operations"}
        className={styles.tabPanel}
      >
        {operations}
      </section>

      <section
        id="admin-panel-analytics"
        role="tabpanel"
        aria-labelledby="admin-tab-analytics"
        hidden={activeTab !== "analytics"}
        className={styles.tabPanel}
      >
        <AdminProductSelector />
        <div className={styles.statisticsPeriod} aria-label="Période des statistiques">
          <span className={styles.statisticsPeriodLabel}>Période</span>
          <div className={styles.statisticsPeriodOptions} role="group" aria-label="Choisir une période">
            {statisticsPeriods.map((period) => (
              <button
                key={period.id}
                className={styles.statisticsPeriodOption}
                type="button"
                aria-pressed={statisticsPeriod === period.id}
                onClick={() => setStatisticsPeriod(period.id)}
              >
                {period.label}
              </button>
            ))}
          </div>
        </div>
        {analytics}
      </section>
    </div>
  );
}
