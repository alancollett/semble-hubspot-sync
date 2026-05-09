import { NextResponse } from "next/server";

const UNUSABLE_EMAILS = new Set([
  "bookings@nationwidepathology.co.uk",
  "care.vl4me@nhs.net",
  "alanjcollett@gmail.com",
]);
const HUBSPOT_CALL_DELAY_MS = 200;
const HUBSPOT_RETRY_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeName(value?: string | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizePhone(value?: string | null): string {
  const digitsOnly = String(value ?? "").replace(/\D/g, "");
  if (!digitsOnly) {
    return "";
  }
  if (digitsOnly.startsWith("440")) {
    return `0${digitsOnly.slice(3)}`;
  }
  if (digitsOnly.startsWith("44")) {
    return `0${digitsOnly.slice(2)}`;
  }
  if (digitsOnly.startsWith("0")) {
    return digitsOnly;
  }
  return digitsOnly;
}

function sanitizeEmail(email?: string | null): string | undefined {
  if (!email) {
    return undefined;
  }

  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.indexOf("@");
  const dotIndex = trimmed.lastIndexOf(".");

  if (atIndex <= 0 || dotIndex <= atIndex + 1 || dotIndex === trimmed.length - 1) {
    return undefined;
  }

  if (UNUSABLE_EMAILS.has(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export async function GET() {
  const pageSize = 100;
  let page = 1;
  let totalFetched = 0;
  let totalSkippedNoPhone = 0;
  let totalCreated = 0;
  let totalBackfilled = 0;
  let totalUpdatedBySembleId = 0;
  let totalMatchedByNamePhone = 0;
  let totalMatchedByNameEmail = 0;
  let totalFailed = 0;
  let totalHubSpotContactsChecked = 0;
  let totalHubSpotContactsWithSemblePatientId = 0;
  let totalHubSpotContactsWithoutSemblePatientId = 0;
  let totalDuplicateConflicts = 0;
  let totalBackfilledMissingSembleId = 0;
  let totalAmbiguousBackfillMatches = 0;
  const hubSpotMissingSembleIdContacts: Array<{
    id: string;
    normalizedFirstName: string;
    normalizedLastName: string;
    normalizedPhone: string;
    hadEmail: boolean;
  }> = [];
  const failedPatients: Array<{
    patientId: string;
    name: string;
    email: string | null;
    phone: string;
    status: number | null;
    error: string;
  }> = [];
  const missingSembleIdHubSpotSamples: Array<{
    patientId: null;
    hubspotId: string;
    hadPhone: boolean;
    hadEmail: boolean;
    hadSemblePatientId: false;
    matchedByNamePhone: false;
    matchedByNameEmail: false;
    duplicateConflict: false;
  }> = [];
  const matchedByNamePhoneSamples: Array<{
    patientId: string;
    hubspotId: string;
    hadPhone: boolean;
    hadEmail: boolean;
    hadSemblePatientId: boolean;
    matchedByNamePhone: true;
    matchedByNameEmail: false;
    duplicateConflict: boolean;
  }> = [];
  const unmatchedSembleSamples: Array<{
    patientId: string;
    hubspotId: null;
    hadPhone: boolean;
    hadEmail: boolean;
    hadSemblePatientId: false;
    matchedByNamePhone: false;
    matchedByNameEmail: false;
    duplicateConflict: false;
  }> = [];
  const duplicateConflictSamples: Array<{
    patientId: string;
    hubspotId: string | null;
    hadPhone: boolean;
    hadEmail: boolean;
    hadSemblePatientId: boolean;
    matchedByNamePhone: boolean;
    matchedByNameEmail: boolean;
    duplicateConflict: true;
  }> = [];
  const ambiguousBackfillSamples: Array<{
    patientId: string;
    hubspotId: null;
    hadPhone: boolean;
    hadEmail: boolean;
    hadSemblePatientId: false;
    matchedByNamePhone: false;
    matchedByNameEmail: false;
    duplicateConflict: false;
  }> = [];

  try {
    const fetchHubSpot = async (url: string, init: RequestInit) => {
      await sleep(HUBSPOT_CALL_DELAY_MS);
      let response = await fetch(url, init);
      if (response.status === 429) {
        await sleep(HUBSPOT_RETRY_DELAY_MS);
        response = await fetch(url, init);
      }
      return response;
    };

    const searchContact = async (
      filters: Array<{
        propertyName: string;
        operator: "EQ";
        value: string;
      }>,
    ) => {
      const searchResponse = await fetchHubSpot(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filterGroups: [
              {
                filters,
              },
            ],
            limit: 1,
          }),
        },
      );

      if (!searchResponse.ok) {
        const errorBody = await searchResponse.text();
        throw new Error(errorBody || "Failed to search HubSpot contact");
      }

      const searchData = await searchResponse.json();
      return searchData?.results?.[0]?.id as string | undefined;
    };

    const upsertWithEmailRetry = async (
      method: "PATCH" | "POST",
      url: string,
      properties: Record<string, string>,
    ) => {
      const runRequest = async (requestProperties: Record<string, string>) =>
        fetchHubSpot(url, {
          method,
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties: requestProperties }),
        });

      let response = await runRequest(properties);
      let hadDuplicateConflict = false;
      if (response.ok) {
        return { response, hadDuplicateConflict };
      }

      const hasEmail = Boolean(properties.email);
      if (hasEmail && response.status === 409) {
        hadDuplicateConflict = true;
        const retryProperties = { ...properties };
        delete retryProperties.email;
        response = await runRequest(retryProperties);
      }

      return { response, hadDuplicateConflict };
    };

    const fetchHubSpotContactDiagnostics = async () => {
      let after: string | undefined;

      while (true) {
        const hubSpotContactsResponse = await fetchHubSpot(
          `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname&properties=lastname&properties=phone&properties=email&properties=semble_patient_id${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!hubSpotContactsResponse.ok) {
          const errorBody = await hubSpotContactsResponse.text();
          throw new Error(
            errorBody || "Failed to fetch HubSpot contacts for diagnostics",
          );
        }

        const hubSpotContactsData = await hubSpotContactsResponse.json();
        const contacts = hubSpotContactsData?.results ?? [];
        totalHubSpotContactsChecked += contacts.length;

        for (const contact of contacts) {
          const semblePatientId = String(contact?.properties?.semble_patient_id ?? "").trim();
          if (semblePatientId) {
            totalHubSpotContactsWithSemblePatientId += 1;
          } else {
            totalHubSpotContactsWithoutSemblePatientId += 1;
            if (missingSembleIdHubSpotSamples.length < 5) {
              missingSembleIdHubSpotSamples.push({
                patientId: null,
                hubspotId: String(contact?.id ?? ""),
                hadPhone: Boolean(contact?.properties?.phone),
                hadEmail: Boolean(contact?.properties?.email),
                hadSemblePatientId: false,
                matchedByNamePhone: false,
                matchedByNameEmail: false,
                duplicateConflict: false,
              });
            }

            hubSpotMissingSembleIdContacts.push({
              id: String(contact?.id ?? ""),
              normalizedFirstName: normalizeName(contact?.properties?.firstname),
              normalizedLastName: normalizeName(contact?.properties?.lastname),
              normalizedPhone: normalizePhone(contact?.properties?.phone),
              hadEmail: Boolean(contact?.properties?.email),
            });
          }
        }

        const nextAfter = hubSpotContactsData?.paging?.next?.after as string | undefined;
        if (!nextAfter) {
          break;
        }
        after = nextAfter;
      }
    };

    await fetchHubSpotContactDiagnostics();

    while (true) {
      const sembleResponse = await fetch(process.env.SEMBLE_API_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-token": process.env.SEMBLE_API_KEY!,
        },
        body: JSON.stringify({
          query: `
            query {
              patients(pagination: { page: ${page}, pageSize: 100 }) {
                data {
                  id
                  firstName
                  lastName
                  email
                  phones {
                    phoneType
                    phoneNumber
                  }
                }
              }
            }
          `,
        }),
      });

      if (!sembleResponse.ok) {
        const errorBody = await sembleResponse.text();
        return NextResponse.json(
          {
            success: false,
            message: "Failed to fetch patients from Semble",
            status: sembleResponse.status,
            error: errorBody,
            page,
          },
          { status: 500 },
        );
      }

      const sembleData = await sembleResponse.json();
      const patients = sembleData?.data?.patients?.data ?? [];

      if (!Array.isArray(patients)) {
        return NextResponse.json(
          {
            success: false,
            message: "Unexpected Semble response format",
            page,
            sembleData,
          },
          { status: 500 },
        );
      }

      if (patients.length === 0) {
        break;
      }

      totalFetched += patients.length;

      for (const patient of patients) {
        const patientId = String(patient?.id ?? "");
        const patientName = `${patient?.firstName ?? ""} ${patient?.lastName ?? ""}`.trim();
        const phoneNumber = patient?.phones?.find(
          (phone: { phoneNumber?: string }) => Boolean(phone?.phoneNumber),
        )?.phoneNumber;

        if (!phoneNumber) {
          totalSkippedNoPhone += 1;
          continue;
        }

        const email = sanitizeEmail(patient?.email);
        const properties: Record<string, string> = {
          firstname: patient.firstName ?? "",
          lastname: patient.lastName ?? "",
          phone: phoneNumber,
          semble_patient_id: patientId,
        };

        try {
          if (!patientId) {
            throw new Error("Semble patient id is missing");
          }

          if (email) {
            properties.email = email;
          }

          let existingContactId = await searchContact([
            {
              propertyName: "semble_patient_id",
              operator: "EQ",
              value: patientId,
            },
          ]);
          let matchMethod: "semble_id" | "name_phone" | "name_email" | "new" = "new";
          let skipCreateForAmbiguousBackfill = false;
          let usedNormalizedBackfillMatch = false;

          if (existingContactId) {
            matchMethod = "semble_id";
          } else {
            const normalizedPatientFirstName = normalizeName(patient.firstName);
            const normalizedPatientLastName = normalizeName(patient.lastName);
            const normalizedPatientPhone = normalizePhone(phoneNumber);
            const normalizedMatches = hubSpotMissingSembleIdContacts.filter((contact) => {
              return (
                contact.normalizedFirstName === normalizedPatientFirstName &&
                contact.normalizedLastName === normalizedPatientLastName &&
                Boolean(normalizedPatientPhone) &&
                contact.normalizedPhone === normalizedPatientPhone
              );
            });

            if (normalizedMatches.length === 1) {
              existingContactId = normalizedMatches[0].id;
              matchMethod = "name_phone";
              usedNormalizedBackfillMatch = true;
            } else if (normalizedMatches.length > 1) {
              totalAmbiguousBackfillMatches += 1;
              skipCreateForAmbiguousBackfill = true;
              if (ambiguousBackfillSamples.length < 5) {
                ambiguousBackfillSamples.push({
                  patientId,
                  hubspotId: null,
                  hadPhone: Boolean(phoneNumber),
                  hadEmail: Boolean(email),
                  hadSemblePatientId: false,
                  matchedByNamePhone: false,
                  matchedByNameEmail: false,
                  duplicateConflict: false,
                });
              }
            }

            if (skipCreateForAmbiguousBackfill) {
              continue;
            }

            if (!existingContactId) {
              existingContactId = await searchContact([
                {
                  propertyName: "firstname",
                  operator: "EQ",
                  value: patient.firstName ?? "",
                },
                {
                  propertyName: "lastname",
                  operator: "EQ",
                  value: patient.lastName ?? "",
                },
                {
                  propertyName: "phone",
                  operator: "EQ",
                  value: phoneNumber,
                },
              ]);

              if (existingContactId) {
                matchMethod = "name_phone";
              } else if (email) {
                existingContactId = await searchContact([
                  {
                    propertyName: "firstname",
                    operator: "EQ",
                    value: patient.firstName ?? "",
                  },
                  {
                    propertyName: "lastname",
                    operator: "EQ",
                    value: patient.lastName ?? "",
                  },
                  {
                    propertyName: "email",
                    operator: "EQ",
                    value: email,
                  },
                ]);

                if (existingContactId) {
                  matchMethod = "name_email";
                }
              }
            }
          }

          if (existingContactId) {
            const updateResult = await upsertWithEmailRetry(
              "PATCH",
              `https://api.hubapi.com/crm/v3/objects/contacts/${existingContactId}`,
              properties,
            );
            const updateResponse = updateResult.response;

            if (updateResult.hadDuplicateConflict) {
              totalDuplicateConflicts += 1;
            }
            if (updateResult.hadDuplicateConflict && duplicateConflictSamples.length < 5) {
              duplicateConflictSamples.push({
                patientId,
                hubspotId: existingContactId,
                hadPhone: Boolean(phoneNumber),
                hadEmail: Boolean(email),
                hadSemblePatientId: matchMethod === "semble_id",
                matchedByNamePhone: matchMethod === "name_phone",
                matchedByNameEmail: matchMethod === "name_email",
                duplicateConflict: true,
              });
            }

            if (!updateResponse.ok) {
              const errorBody = await updateResponse.text();
              totalFailed += 1;
              failedPatients.push({
                patientId,
                name: patientName,
                email: email ?? null,
                phone: phoneNumber,
                status: updateResponse.status,
                error: errorBody || "Failed to update HubSpot contact",
              });
              continue;
            }

            if (matchMethod === "semble_id") {
              totalUpdatedBySembleId += 1;
            } else if (matchMethod === "name_phone") {
              totalMatchedByNamePhone += 1;
              totalBackfilled += 1;
              if (usedNormalizedBackfillMatch) {
                totalBackfilledMissingSembleId += 1;
              }
              if (matchedByNamePhoneSamples.length < 5) {
                matchedByNamePhoneSamples.push({
                  patientId,
                  hubspotId: existingContactId,
                  hadPhone: Boolean(phoneNumber),
                  hadEmail: Boolean(email),
                  hadSemblePatientId: false,
                  matchedByNamePhone: true,
                  matchedByNameEmail: false,
                  duplicateConflict: updateResult.hadDuplicateConflict,
                });
              }
            } else if (matchMethod === "name_email") {
              totalMatchedByNameEmail += 1;
              totalBackfilled += 1;
            }
          } else {
            if (unmatchedSembleSamples.length < 5) {
              unmatchedSembleSamples.push({
                patientId,
                hubspotId: null,
                hadPhone: Boolean(phoneNumber),
                hadEmail: Boolean(email),
                hadSemblePatientId: false,
                matchedByNamePhone: false,
                matchedByNameEmail: false,
                duplicateConflict: false,
              });
            }

            const createResult = await upsertWithEmailRetry(
              "POST",
              "https://api.hubapi.com/crm/v3/objects/contacts",
              properties,
            );
            const createResponse = createResult.response;

            if (createResult.hadDuplicateConflict) {
              totalDuplicateConflicts += 1;
            }
            if (createResult.hadDuplicateConflict && duplicateConflictSamples.length < 5) {
              duplicateConflictSamples.push({
                patientId,
                hubspotId: null,
                hadPhone: Boolean(phoneNumber),
                hadEmail: Boolean(email),
                hadSemblePatientId: false,
                matchedByNamePhone: false,
                matchedByNameEmail: false,
                duplicateConflict: true,
              });
            }

            if (!createResponse.ok) {
              const errorBody = await createResponse.text();
              totalFailed += 1;
              failedPatients.push({
                patientId,
                name: patientName,
                email: email ?? null,
                phone: phoneNumber,
                status: createResponse.status,
                error: errorBody || "Failed to create HubSpot contact",
              });
              continue;
            }

            totalCreated += 1;
          }
        } catch (error) {
          totalFailed += 1;
          failedPatients.push({
            patientId,
            name: patientName,
            email: email ?? null,
            phone: phoneNumber,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      page += 1;
    }
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: "Unexpected sync error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    fetched: totalFetched,
    skippedNoPhone: totalSkippedNoPhone,
    updatedBySembleId: totalUpdatedBySembleId,
    matchedByNamePhone: totalMatchedByNamePhone,
    matchedByNameEmail: totalMatchedByNameEmail,
    backfilled: totalBackfilled,
    created: totalCreated,
    failed: totalFailed,
    failedPatients,
    diagnostics: {
      hubSpotContactsChecked: totalHubSpotContactsChecked,
      hubSpotContactsWithSemblePatientId: totalHubSpotContactsWithSemblePatientId,
      hubSpotContactsWithoutSemblePatientId: totalHubSpotContactsWithoutSemblePatientId,
      duplicateConflicts: totalDuplicateConflicts,
      backfilledMissingSembleId: totalBackfilledMissingSembleId,
      ambiguousBackfillMatches: totalAmbiguousBackfillMatches,
      matchingPathCounts: {
        matchedBySembleId: totalUpdatedBySembleId,
        matchedByNamePhone: totalMatchedByNamePhone,
        matchedByNameEmail: totalMatchedByNameEmail,
        noMatchCreated: totalCreated,
        skippedNoPhone: totalSkippedNoPhone,
      },
      missingSembleIdHubSpotSamples,
      matchedByNamePhoneSamples,
      unmatchedSembleSamples,
      duplicateConflictSamples,
      ambiguousBackfillSamples,
      matchingBehavior: {
        searchesHubSpotContactsWithoutSemblePatientId: true,
        note: "After semble_patient_id lookup, name+phone and name+email searches are global HubSpot contact searches without requiring semble_patient_id.",
      },
      normalization: {
        phoneNormalizedBeforeComparison: true,
        namesNormalizedBeforeComparison: true,
        note: "Name and phone are normalized for backfill matching against HubSpot contacts missing semble_patient_id; other HubSpot search filters remain exact-match.",
      },
    },
    pageSize,
    pagesProcessed: page - 1,
  });
}